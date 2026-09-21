import "dotenv/config";
import express from "express";
import { extraerDatosComprobante } from "./ocr.js";
import { guardarComprobante, asegurarEncabezados } from "./sheets.js";

const app = express();
app.use(express.json());

const {
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,
  PORT = 3000,
} = process.env;

const GRAPH_URL = "https://graph.facebook.com/v20.0";

// --- Estado de conversación por número de teléfono ---
//
// Para cada número, en un momento dado solo puede haber UNA sesión activa:
//   { tipo: "procesando" }   -> se está leyendo la foto con IA (todavía no hay preguntas)
//   { tipo: "preguntando", remitente, listaDatos, preguntas, indice, fechaMensaje }
//                             -> esperando que responda una pregunta de seguimiento
//
// Si llega una foto NUEVA mientras el número ya tiene una sesión activa, esa
// foto se guarda en una cola (colaPorTelefono) en vez de procesarse en
// paralelo — así nunca se pisan los datos de dos fotos mandadas seguidas.
// Apenas se termina de guardar la sesión actual, se toma automáticamente la
// siguiente foto de la cola (si hay alguna) y se procesa.
//
// IMPORTANTE: todo esto vive en la MEMORIA del proceso, no en Google Sheets
// ni en una base de datos. Si el servidor se reinicia (ej. al desplegar un
// cambio) mientras hay sesiones o colas activas, se pierden y habría que
// volver a mandar esas fotos. Para el volumen de uso actual esto es
// aceptable.
const sesionesPorTelefono = new Map();
const colaPorTelefono = new Map();

// Tipos de documento para los que tiene sentido preguntar a qué factura
// corresponde el pago (no aplica a facturas, notas de crédito/remisión, etc,
// que ya son la factura o no llevan número de factura propio).
const TIPOS_DE_PAGO = ["transferencia", "deposito", "cheque", "efectivo"];

// Respuestas que interpretamos como "no sé / no aplica" en vez de un dato real.
const RESPUESTAS_SALTEAR = ["no", "no se", "no sé", "n/a", "na", "-", "ns", "nose"];

// --- 1. Verificación del webhook (Meta la llama una sola vez al configurar) ---
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// --- 2. Recepción de mensajes ---
app.post("/webhook", async (req, res) => {
  // Respondemos rápido a Meta para que no reintente el envío
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const message = change?.messages?.[0];
    if (!message) return; // no es un mensaje entrante (puede ser un "status")

    const remitente = {
      telefono: message.from,
      nombre: change.contacts?.[0]?.profile?.name || "",
    };

    const sesionActual = sesionesPorTelefono.get(remitente.telefono);

    // Si este número tiene una pregunta pendiente y nos escribió texto,
    // lo tratamos como la respuesta a esa pregunta.
    if (message.type === "text" && sesionActual?.tipo === "preguntando") {
      await manejarRespuesta(remitente, message.text?.body || "");
      return;
    }

    // Si tocó una opción del menú (lista interactiva), confirmamos y le
    // pedimos que mande la foto/PDF de ese tipo de documento.
    if (message.type === "interactive" && message.interactive?.type === "list_reply") {
      const opcion = message.interactive.list_reply;
      await enviarMensajeTexto(
        remitente.telefono,
        `Perfecto, *${opcion.title}*. Mandame la foto o el PDF del documento cuando quieras.`
      );
      return;
    }

    const esImagen = message.type === "image";
    const esDocumentoPdf =
      message.type === "document" && message.document?.mime_type === "application/pdf";

    // Si escribió texto (sin pregunta pendiente) — probablemente un saludo o
    // "hola" — le mostramos el menú de opciones en vez de procesar nada.
    if (message.type === "text") {
      await enviarMenuPrincipal(remitente.telefono);
      return;
    }

    if (!esImagen && !esDocumentoPdf) {
      await enviarMensajeTexto(
        remitente.telefono,
        "Por favor enviá una *foto* o un *PDF* del comprobante (transferencia, depósito, cheque, efectivo o factura)."
      );
      return;
    }

    const mediaId = esImagen ? message.image.id : message.document.id;
    const { buffer, mediaType } = await descargarMedia(mediaId);

    // WhatsApp informa "timestamp" (segundos Unix) del momento en que se
    // envió el mensaje, más preciso que la hora del servidor.
    const fechaMensaje = message.timestamp
      ? new Date(Number(message.timestamp) * 1000).toISOString()
      : new Date().toISOString();

    if (sesionActual) {
      // Ya hay algo en curso para este número (procesando una foto anterior,
      // o esperando que responda una pregunta): encolamos esta foto nueva en
      // vez de procesarla en paralelo, para no perder ni mezclar datos.
      const cola = colaPorTelefono.get(remitente.telefono) || [];
      cola.push({ remitente, buffer, mediaType, fechaMensaje });
      colaPorTelefono.set(remitente.telefono, cola);
      await enviarMensajeTexto(
        remitente.telefono,
        "Recibí esta foto también — la proceso apenas terminemos con la anterior."
      );
      return;
    }

    await procesarImagen(remitente, buffer, mediaType, fechaMensaje);
  } catch (err) {
    console.error("Error procesando mensaje:", err);
  }
});

/** Marca al número como "ocupado", extrae los datos, y sigue el flujo normal. */
async function procesarImagen(remitente, buffer, mediaType, fechaMensaje) {
  sesionesPorTelefono.set(remitente.telefono, { tipo: "procesando" });
  const listaDatos = await extraerDatosComprobante(buffer, mediaType);
  await iniciarOFinalizarFlujo(remitente, listaDatos, fechaMensaje);
}

/**
 * Decide si hace falta preguntar algo antes de guardar (ej. número de
 * factura de un pago), o si ya podemos guardar directo en la planilla.
 */
async function iniciarOFinalizarFlujo(remitente, listaDatos, fechaMensaje) {
  const preguntas = construirPreguntas(listaDatos);

  if (preguntas.length === 0) {
    await guardarComprobante(listaDatos, remitente, fechaMensaje);
    await enviarMensajeTexto(remitente.telefono, construirResumen(listaDatos));
    sesionesPorTelefono.delete(remitente.telefono);
    await procesarSiguienteEnCola(remitente.telefono);
    return;
  }

  sesionesPorTelefono.set(remitente.telefono, {
    tipo: "preguntando",
    remitente,
    listaDatos,
    preguntas,
    indice: 0,
    fechaMensaje,
  });
  await enviarMensajeTexto(remitente.telefono, preguntas[0].texto);
}

/**
 * Arma la lista de preguntas de seguimiento para los documentos que las
 * necesiten. Hoy solo pregunta el número de factura en comprobantes de pago
 * que no lo traen, pero está pensado para poder sumar más preguntas después.
 */
function construirPreguntas(listaDatos) {
  const preguntas = [];

  listaDatos.forEach((datos, docIndex) => {
    if (TIPOS_DE_PAGO.includes(datos.tipo_comprobante) && !datos.numero_factura) {
      const monto = datos.monto ? `${datos.monto} ${datos.moneda || ""}`.trim() : "";
      const referencia = listaDatos.length > 1 ? ` (documento ${docIndex + 1} de la foto)` : "";
      preguntas.push({
        docIndex,
        campo: "numero_factura",
        texto:
          `Para el ${datos.tipo_comprobante}${monto ? ` de ${monto}` : ""}${referencia}: ` +
          `¿a qué número de factura corresponde? (si no sabés, respondé "no")`,
      });
    }
  });

  return preguntas;
}

/** Procesa la respuesta del usuario a la pregunta actual de su conversación. */
async function manejarRespuesta(remitente, textoRespuesta) {
  const estado = sesionesPorTelefono.get(remitente.telefono);
  if (!estado || estado.tipo !== "preguntando") return;

  const preguntaActual = estado.preguntas[estado.indice];
  const respuestaLimpia = textoRespuesta.trim();
  const seSaltea = RESPUESTAS_SALTEAR.includes(respuestaLimpia.toLowerCase());

  estado.listaDatos[preguntaActual.docIndex][preguntaActual.campo] = seSaltea
    ? null
    : respuestaLimpia;

  estado.indice += 1;

  if (estado.indice < estado.preguntas.length) {
    await enviarMensajeTexto(remitente.telefono, estado.preguntas[estado.indice].texto);
    return;
  }

  // No quedan más preguntas: guardamos todo junto, mandamos el resumen, y
  // recién ahí liberamos al número para que pueda procesarse lo que haya
  // quedado esperando en la cola.
  await guardarComprobante(estado.listaDatos, estado.remitente, estado.fechaMensaje);
  await enviarMensajeTexto(estado.remitente.telefono, construirResumen(estado.listaDatos));
  sesionesPorTelefono.delete(remitente.telefono);
  await procesarSiguienteEnCola(remitente.telefono);
}

/** Si hay una foto esperando en la cola de este número, la procesa ahora. */
async function procesarSiguienteEnCola(telefono) {
  const cola = colaPorTelefono.get(telefono);
  if (!cola || cola.length === 0) return;

  const siguiente = cola.shift();
  if (cola.length === 0) {
    colaPorTelefono.delete(telefono);
  } else {
    colaPorTelefono.set(telefono, cola);
  }

  await procesarImagen(siguiente.remitente, siguiente.buffer, siguiente.mediaType, siguiente.fechaMensaje);
}

/** Descarga la imagen/documento desde los servidores de Meta usando el media id. */
async function descargarMedia(mediaId) {
  const metaRes = await fetch(`${GRAPH_URL}/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  const { url, mime_type } = await metaRes.json();

  const fileRes = await fetch(url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  const arrayBuffer = await fileRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // WhatsApp a veces informa un mime_type genérico (ej. "image/jpeg") aunque el
  // archivo real sea otro formato (ej. PNG), y Anthropic rechaza esa
  // inconsistencia. Para imágenes, detectamos el tipo real mirando los primeros
  // bytes del archivo en vez de confiar ciegamente en lo que dice WhatsApp.
  const mediaType = mime_type === "application/pdf" ? mime_type : detectarTipoImagen(buffer, mime_type);

  return { buffer, mediaType };
}

/** Detecta el tipo real de una imagen por su firma de bytes (magic numbers). */
function detectarTipoImagen(buffer, mimeTypeInformado) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  // Si no reconocemos la firma, usamos lo que informó WhatsApp como respaldo.
  return mimeTypeInformado || "image/jpeg";
}

/** Envía el menú de opciones (lista interactiva) con los tipos de documento. */
async function enviarMenuPrincipal(to) {
  await fetch(`${GRAPH_URL}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: "Registrar operación" },
        body: { text: "Buenas! ¿Le gustaría registrar alguna operación? A continuación elija la opción, por favor." },
        footer: { text: "Después de elegir, mandá la foto o el PDF" },
        action: {
          button: "Ver opciones",
          sections: [
            {
              title: "Tipos de documento",
              rows: [
                { id: "transferencia", title: "Transferencia", description: "Comprobante de transferencia bancaria" },
                { id: "deposito", title: "Depósito", description: "Boleta de depósito" },
                { id: "cheque", title: "Cheque", description: "Foto de un cheque" },
                { id: "efectivo", title: "Efectivo", description: "Recibo de pago en efectivo" },
                { id: "factura", title: "Factura", description: "Factura electrónica" },
                { id: "nota_credito", title: "Nota de crédito", description: "Nota de crédito electrónica" },
                { id: "nota_remision", title: "Nota de remisión", description: "Remisión de mercadería" },
                { id: "remision_combustible", title: "Remisión de combustible", description: "Ticket de carga de combustible" },
                { id: "recibo_viatico", title: "Recibo de viático", description: "Recibo de dinero entregado" },
                { id: "lectura_surtidor", title: "Lectura de surtidor", description: "Foto del totalizador del pico" },
              ],
            },
          ],
        },
      },
    }),
  });
}

/** Envía un mensaje de texto de vuelta al remitente. */
async function enviarMensajeTexto(to, body) {
  await fetch(`${GRAPH_URL}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      text: { body },
    }),
  });
}

function construirResumen(listaDatos) {
  if (listaDatos.length === 1) {
    const d = listaDatos[0];
    return (
      `✅ Comprobante registrado.\n\n` +
      `Tipo: ${d.tipo_comprobante || "-"}\n` +
      `Cliente: ${d.nombre_cliente || "-"}\n` +
      `RUC: ${d.ruc_cliente || "-"}\n` +
      `Nro Factura: ${d.numero_factura || "-"}\n` +
      `Fecha: ${d.fecha_comprobante || "-"}\n` +
      `Monto: ${d.monto ?? "-"} ${d.moneda || ""}\n\n` +
      `Si algún dato está mal, respondé con la corrección y se actualizará.`
    );
  }

  const items = listaDatos
    .map(
      (d, i) =>
        `${i + 1}) ${d.tipo_comprobante || "-"} | ${d.nombre_cliente || "-"} | ` +
        `${d.monto ?? "-"} ${d.moneda || ""} | Nro: ${d.numero_operacion || "-"} | Factura: ${d.numero_factura || "-"}`
    )
    .join("\n");

  return (
    `✅ Se registraron ${listaDatos.length} comprobantes de esta imagen:\n\n` +
    `${items}\n\n` +
    `Si algún dato está mal, respondé con la corrección y se actualizará.`
  );
}

app.listen(PORT, async () => {
  await asegurarEncabezados();
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
