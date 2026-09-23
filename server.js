import "dotenv/config";
import express from "express";
import cron from "node-cron";
import { extraerDatosComprobante, corregirDatos } from "./ocr.js";
import {
  guardarComprobante,
  actualizarComprobante,
  asegurarEncabezados,
  obtenerTelefonosRegistradosHoy,
} from "./sheets.js";
import { subirFoto } from "./storage.js";

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

// Último documento guardado por cada número, disponible por un tiempo para
// que la persona pueda corregirlo escribiendo en lenguaje natural (ej. "el
// monto era 5.000.000 no 500.000"). Guarda el rango exacto de celdas donde
// se escribió, para poder sobrescribir esas mismas filas en vez de crear
// filas nuevas cada vez que se corrige algo.
const ultimosRegistrosPorTelefono = new Map();
const VENTANA_CORRECCION_MS = 15 * 60 * 1000; // 15 minutos

// Números que ya eligieron un tipo de documento en el menú y todavía no
// mandaron la foto correspondiente. El bot NO procesa una foto si el número
// no está en este set — primero hay que elegir una opción del menú. Se
// "consume" (se saca del set) apenas llega la foto, así que hay que volver a
// elegir en el menú antes de cada foto nueva.
const eligioTipoPorTelefono = new Set();

// Sub-flujo especial para "Lectura de surtidor": antes de habilitar la foto,
// hay que preguntar la estación (texto libre) y el tipo de combustible (un
// mini-menú aparte). Mientras se arma esto, el número tiene una entrada acá:
//   { paso: "estacion" }                          -> esperando el nombre de la estación
//   { paso: "combustible", estacion }              -> esperando que elija el combustible
// Una vez completo, los datos quedan en contextoLecturaPorTelefono para
// mezclarlos con lo que la IA extraiga de la foto del totalizador.
const armandoLecturaPorTelefono = new Map();
const contextoLecturaPorTelefono = new Map();

const TIPOS_COMBUSTIBLE = [
  { id: "combustible_comun89", title: "Común 89" },
  { id: "combustible_especial93", title: "Especial 93" },
  { id: "combustible_super97", title: "Súper 97" },
  { id: "combustible_diesel", title: "Diesel" },
  { id: "combustible_ultra", title: "Ultra" },
  { id: "combustible_alcohol", title: "Alcohol" },
];

// Tipos de documento para los que tiene sentido preguntar a qué factura
// corresponde el pago (no aplica a facturas, notas de crédito/remisión, etc,
// que ya son la factura o no llevan número de factura propio).
const TIPOS_DE_PAGO = ["transferencia", "deposito", "cheque", "efectivo"];

// Respuestas que interpretamos como "no sé / no aplica" en vez de un dato real.
const RESPUESTAS_SALTEAR = ["no", "no se", "no sé", "n/a", "na", "-", "ns", "nose"];

// Instrucciones específicas para cada categoría del menú, que se mandan
// cuando la persona elige esa opción.
const INSTRUCCIONES_POR_TIPO = {
  pago:
    "Perfecto, *Comprobante de pago*. Mandame la foto o captura de la transferencia, " +
    "el depósito, el cheque o el recibo de efectivo. Asegurate de que se vean bien: " +
    "quién paga, el monto, la fecha y el número de operación o cheque.",
  factura:
    "Perfecto, *Factura / Nota de crédito*. Mandame la foto o el PDF completo, que se " +
    "vea el número de documento, el RUC del cliente y el detalle de ítems o el motivo " +
    "del ajuste.",
  remision:
    "Perfecto, *Nota de remisión*. Mandame la foto o el PDF completo: si es traslado de " +
    "mercadería, que se vean los datos del destinatario y el transportista; si es un " +
    "ticket de combustible, que se vea el vehículo, el chofer y el total a pagar.",
  recibo_viatico:
    "Perfecto, *Recibo de viático*. Mandame la foto del recibo de dinero, con el nombre " +
    "de quien lo recibe y el monto bien visibles.",
  lectura_surtidor:
    "Perfecto, *Lectura de surtidor*. Mandame la foto del contador del pico, que se vea " +
    "bien el número de pico y la lectura completa del totalizador.",
};

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

    console.log(
      `Mensaje de ${remitente.telefono} — type: "${message.type}"` +
        (message.type === "document" ? `, document.mime_type: "${message.document?.mime_type}"` : "")
    );

    const sesionActual = sesionesPorTelefono.get(remitente.telefono);

    // Si este número tiene una pregunta pendiente y nos escribió texto,
    // lo tratamos como la respuesta a esa pregunta.
    if (message.type === "text" && sesionActual?.tipo === "preguntando") {
      await manejarRespuesta(remitente, message.text?.body || "");
      return;
    }

    // Sub-flujo de "Lectura de surtidor": si está esperando el nombre de la
    // estación, este texto es la respuesta.
    if (message.type === "text" && armandoLecturaPorTelefono.get(remitente.telefono)?.paso === "estacion") {
      const estacion = (message.text?.body || "").trim();
      armandoLecturaPorTelefono.set(remitente.telefono, { paso: "combustible", estacion });
      await enviarMenuCombustible(remitente.telefono);
      return;
    }

    // Si tocó una opción del menú (lista interactiva).
    if (message.type === "interactive" && message.interactive?.type === "list_reply") {
      const opcion = message.interactive.list_reply;

      if (opcion.id === "finalizar") {
        eligioTipoPorTelefono.delete(remitente.telefono);
        ultimosRegistrosPorTelefono.delete(remitente.telefono);
        armandoLecturaPorTelefono.delete(remitente.telefono);
        contextoLecturaPorTelefono.delete(remitente.telefono);
        await enviarMensajeTexto(
          remitente.telefono,
          "¡Listo! Gracias por usar el bot 🙌. Escribime cuando quieras registrar algo más."
        );
        return;
      }

      // "Lectura de surtidor" tiene un sub-flujo propio: primero preguntamos
      // la estación y el tipo de combustible, y recién ahí habilitamos la foto.
      if (opcion.id === "lectura_surtidor") {
        armandoLecturaPorTelefono.set(remitente.telefono, { paso: "estacion" });
        await enviarMensajeTexto(remitente.telefono, "¿A qué estación corresponde esta lectura?");
        return;
      }

      // Si está esperando que elija el combustible, y tocó una de esas opciones.
      const armando = armandoLecturaPorTelefono.get(remitente.telefono);
      if (armando?.paso === "combustible") {
        const combustible = TIPOS_COMBUSTIBLE.find((c) => c.id === opcion.id);
        if (combustible) {
          contextoLecturaPorTelefono.set(remitente.telefono, {
            estacion: armando.estacion,
            tipo_combustible: combustible.title,
          });
          armandoLecturaPorTelefono.delete(remitente.telefono);
          eligioTipoPorTelefono.add(remitente.telefono);
          await enviarMensajeTexto(
            remitente.telefono,
            `Perfecto, *${armando.estacion}* / *${combustible.title}*. Ahora mandame la foto del contador del pico.`
          );
          return;
        }
      }

      // Marcamos que este número ya eligió un tipo, así se habilita mandar
      // UNA foto. Hay que volver a elegir en el menú antes de la próxima.
      eligioTipoPorTelefono.add(remitente.telefono);
      const instrucciones =
        INSTRUCCIONES_POR_TIPO[opcion.id] ||
        `Perfecto, *${opcion.title}*. Mandame la foto o el PDF del documento cuando quieras.`;
      await enviarMensajeTexto(remitente.telefono, instrucciones);
      return;
    }

    const esImagen = message.type === "image";
    const esDocumentoPdf =
      message.type === "document" && message.document?.mime_type === "application/pdf";
    const esDocumentoImagen =
      message.type === "document" && (message.document?.mime_type || "").startsWith("image/");

    // Si escribió texto (sin pregunta pendiente) y hay un documento reciente
    // que todavía se puede corregir, lo tratamos como una corrección en vez
    // de mostrar el menú.
    if (message.type === "text") {
      const registroReciente = ultimosRegistrosPorTelefono.get(remitente.telefono);
      if (registroReciente && registroReciente.expira > Date.now()) {
        await manejarCorreccion(remitente, message.text?.body || "", registroReciente);
        return;
      }
      await enviarMenuPrincipal(remitente.telefono);
      return;
    }

    if (!esImagen && !esDocumentoPdf && !esDocumentoImagen) {
      await enviarMensajeTexto(
        remitente.telefono,
        "Por favor enviá una *foto* o un *PDF* del comprobante (transferencia, depósito, cheque, efectivo o factura)."
      );
      return;
    }

    // Obligamos a elegir primero una opción del menú antes de aceptar la foto.
    if (!eligioTipoPorTelefono.has(remitente.telefono)) {
      await enviarMensajeTexto(
        remitente.telefono,
        "Antes de mandar la foto, elegí primero qué tipo de documento es 👇"
      );
      await enviarMenuPrincipal(remitente.telefono);
      return;
    }
    eligioTipoPorTelefono.delete(remitente.telefono); // se consume con esta foto

    // Si venía del sub-flujo de "Lectura de surtidor", tomamos la estación y
    // el combustible ya elegidos para mezclarlos con lo que lea la IA.
    const contextoExtra = contextoLecturaPorTelefono.get(remitente.telefono) || null;
    contextoLecturaPorTelefono.delete(remitente.telefono);

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
      cola.push({ remitente, buffer, mediaType, fechaMensaje, contextoExtra });
      colaPorTelefono.set(remitente.telefono, cola);
      await enviarMensajeTexto(
        remitente.telefono,
        "Recibí esta foto también — la proceso apenas terminemos con la anterior."
      );
      return;
    }

    await procesarImagen(remitente, buffer, mediaType, fechaMensaje, contextoExtra);
  } catch (err) {
    console.error("Error procesando mensaje:", err);
  }
});

/** Marca al número como "ocupado", extrae los datos, y sigue el flujo normal. */
async function procesarImagen(remitente, buffer, mediaType, fechaMensaje, contextoExtra) {
  sesionesPorTelefono.set(remitente.telefono, { tipo: "procesando" });

  // Subimos la foto a Drive en paralelo con la extracción de datos, para no
  // perder tiempo esperando una cosa antes de la otra.
  const extension = mediaType === "application/pdf" ? "pdf" : mediaType.split("/")[1] || "jpg";
  const nombreArchivo = `${remitente.telefono}_${fechaMensaje.replace(/[:.]/g, "-")}.${extension}`;

  const [listaDatos, linkFoto] = await Promise.all([
    extraerDatosComprobante(buffer, mediaType),
    subirFoto(buffer, mediaType, nombreArchivo),
  ]);

  // Si venía del sub-flujo de estación/combustible, lo completamos en cada
  // documento detectado (la IA no puede leer esto de la foto del totalizador).
  if (contextoExtra) {
    for (const datos of listaDatos) {
      datos.estacion = contextoExtra.estacion;
      datos.tipo_combustible = contextoExtra.tipo_combustible;
    }
  }

  await iniciarOFinalizarFlujo(remitente, listaDatos, fechaMensaje, linkFoto);
}

/**
 * Decide si hace falta preguntar algo antes de guardar (ej. número de
 * factura de un pago), o si ya podemos guardar directo en la planilla.
 */
async function iniciarOFinalizarFlujo(remitente, listaDatos, fechaMensaje, linkFoto) {
  const preguntas = construirPreguntas(listaDatos);

  if (preguntas.length === 0) {
    const rango = await guardarComprobante(listaDatos, remitente, fechaMensaje, linkFoto);
    ultimosRegistrosPorTelefono.set(remitente.telefono, {
      listaDatos,
      rango,
      remitente,
      fechaRegistro: fechaMensaje,
      linkFoto,
      expira: Date.now() + VENTANA_CORRECCION_MS,
    });
    await enviarMensajeTexto(remitente.telefono, construirResumen(listaDatos));
    sesionesPorTelefono.delete(remitente.telefono);
    await procesarSiguienteEnCola(remitente.telefono);
    await enviarMenuPrincipal(remitente.telefono);
    return;
  }

  sesionesPorTelefono.set(remitente.telefono, {
    tipo: "preguntando",
    remitente,
    listaDatos,
    preguntas,
    indice: 0,
    fechaMensaje,
    linkFoto,
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
  const rango = await guardarComprobante(estado.listaDatos, estado.remitente, estado.fechaMensaje, estado.linkFoto);
  ultimosRegistrosPorTelefono.set(remitente.telefono, {
    listaDatos: estado.listaDatos,
    rango,
    remitente: estado.remitente,
    fechaRegistro: estado.fechaMensaje,
    linkFoto: estado.linkFoto,
    expira: Date.now() + VENTANA_CORRECCION_MS,
  });
  await enviarMensajeTexto(estado.remitente.telefono, construirResumen(estado.listaDatos));
  sesionesPorTelefono.delete(remitente.telefono);
  await procesarSiguienteEnCola(remitente.telefono);
  await enviarMenuPrincipal(remitente.telefono);
}

/**
 * Interpreta una corrección en lenguaje natural sobre el último documento
 * guardado de este número, y sobrescribe esas mismas filas en la planilla
 * (no crea filas nuevas).
 */
async function manejarCorreccion(remitente, textoCorreccion, registroReciente) {
  const corregido = await corregirDatos(registroReciente.listaDatos, textoCorreccion);

  if (!corregido) {
    await enviarMensajeTexto(
      remitente.telefono,
      "No pude entender bien esa corrección 🤔. ¿Podés reformularla, por ejemplo indicando qué dato estaba mal y cuál es el valor correcto?"
    );
    return;
  }

  const rangoNuevo = await actualizarComprobante(
    registroReciente.rango,
    corregido,
    registroReciente.remitente,
    registroReciente.fechaRegistro,
    registroReciente.linkFoto
  );

  ultimosRegistrosPorTelefono.set(remitente.telefono, {
    ...registroReciente,
    listaDatos: corregido,
    rango: rangoNuevo,
    expira: Date.now() + VENTANA_CORRECCION_MS,
  });

  await enviarMensajeTexto(
    remitente.telefono,
    `✅ Corregido. Así quedaron los datos ahora:\n\n${construirResumen(corregido)}`
  );
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

  await procesarImagen(
    siguiente.remitente,
    siguiente.buffer,
    siguiente.mediaType,
    siguiente.fechaMensaje,
    siguiente.contextoExtra
  );
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
/** Envía el sub-menú con los tipos de combustible para "Lectura de surtidor". */
async function enviarMenuCombustible(to) {
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
        header: { type: "text", text: "Tipo de combustible" },
        body: { text: "¿Qué tipo de combustible es?" },
        action: {
          button: "Ver opciones",
          sections: [{ title: "Combustibles", rows: TIPOS_COMBUSTIBLE.map(({ id, title }) => ({ id, title })) }],
        },
      },
    }),
  });
}

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
                { id: "pago", title: "Comprobante de pago", description: "Transferencia, depósito, cheque o efectivo" },
                { id: "factura", title: "Factura / N. Crédito", description: "Factura o nota de crédito electrónica" },
                { id: "remision", title: "Nota de remisión", description: "Remisión de mercadería o combustible" },
                { id: "recibo_viatico", title: "Recibo de viático", description: "Recibo de dinero entregado" },
                { id: "lectura_surtidor", title: "Lectura de surtidor", description: "Foto del totalizador del pico" },
                { id: "finalizar", title: "Finalizar", description: "Terminar la conversación por ahora" },
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

// Nombres legibles para cada tipo de documento.
const TIPO_DISPLAY = {
  transferencia: "Transferencia",
  deposito: "Depósito",
  cheque: "Cheque",
  efectivo: "Efectivo",
  factura: "Factura",
  nota_credito: "Nota de crédito",
  nota_remision: "Nota de remisión",
  remision_combustible: "Remisión de combustible",
  recibo_viatico: "Recibo de viático",
  lectura_surtidor: "Lectura de surtidor",
  otro: "Otro",
};

// Etiqueta en español para cada campo (salvo tipo_comprobante, monto/moneda e
// items, que se arman aparte porque necesitan formato especial).
const ETIQUETAS_CAMPOS = {
  nombre_cliente: "Cliente",
  ruc_cliente: "RUC/CI cliente",
  nombre_beneficiario: "Beneficiario",
  cuenta_origen: "Cuenta origen",
  cuenta_destino: "Cuenta destino",
  concepto: "Concepto",
  numero_factura: "Nro Documento",
  condicion_venta: "Condición de venta",
  fecha_comprobante: "Fecha",
  fecha_pago: "Fecha de pago",
  banco_o_entidad: "Banco/Entidad",
  numero_operacion: "Nro Operación/Cheque",
  numeral: "Numeral",
  pico: "Pico",
  estacion: "Estación",
  tipo_combustible: "Tipo de combustible",
  firmante: "Firmante",
  ci_firmante: "C.I. Firmante",
  emisor_factura: "Emisor",
  ruc_emisor: "RUC Emisor",
  timbrado: "Timbrado",
  transportista: "Transportista",
  chofer: "Chofer",
  ci_chofer: "C.I. Chofer",
  vehiculo: "Vehículo",
  matricula_vehiculo: "Matrícula",
  direccion_salida: "Salida",
  direccion_entrega: "Entrega",
  km_recorrido: "Km",
  motivo_traslado: "Motivo traslado",
  observaciones: "Observaciones",
};

/** Arma el texto de un documento mostrando TODOS los campos que tengan valor. */
function formatearDocumento(d) {
  const lineas = [`Tipo: ${TIPO_DISPLAY[d.tipo_comprobante] || d.tipo_comprobante || "-"}`];

  for (const [campo, etiqueta] of Object.entries(ETIQUETAS_CAMPOS)) {
    const valor = d[campo];
    if (valor === null || valor === undefined || valor === "") continue;
    lineas.push(`${etiqueta}: ${valor}`);
  }

  if (d.monto !== null && d.monto !== undefined) {
    lineas.push(`Monto: ${d.monto} ${d.moneda || ""}`.trim());
  }

  if (Array.isArray(d.items) && d.items.length > 0) {
    lineas.push("Ítems:");
    d.items.forEach((item, i) => {
      const partes = [];
      if (item.codigo) partes.push(item.codigo);
      if (item.descripcion) partes.push(item.descripcion);
      if (item.unidad_medida) partes.push(item.unidad_medida);
      if (item.cantidad != null) partes.push(`x${item.cantidad}`);
      if (item.costo_unitario != null) partes.push(`@ ${item.costo_unitario}`);
      if (item.subtotal_item != null) partes.push(`= ${item.subtotal_item}`);
      lineas.push(`  ${i + 1}. ${partes.join(" ") || "-"}`);
    });
  }

  return lineas.join("\n");
}

function construirResumen(listaDatos) {
  const bloques = listaDatos.map((d, i) => {
    const encabezado = listaDatos.length > 1 ? `*Documento ${i + 1} de ${listaDatos.length}*\n` : "";
    return encabezado + formatearDocumento(d);
  });

  const titulo =
    listaDatos.length > 1
      ? `✅ Se registraron ${listaDatos.length} documentos. Revisá que todo esté correcto:`
      : `✅ Registrado. Revisá que todo esté correcto:`;

  return (
    `${titulo}\n\n` +
    bloques.join("\n\n— — —\n\n") +
    `\n\nSi algún dato está mal, respondé con la corrección y se actualizará.`
  );
}

// --- Aviso diario si alguna sucursal no mandó nada ---
//
// SUCURSALES_JSON: mapa de "número de WhatsApp": "nombre de la sucursal".
// ADMIN_PHONES: números (separados por coma) a los que avisar si falta algo.
// Si cualquiera de las dos variables no está configurada, este chequeo
// queda desactivado sin afectar el resto del bot.
const SUCURSALES = process.env.SUCURSALES_JSON ? JSON.parse(process.env.SUCURSALES_JSON) : {};
const ADMIN_PHONES = (process.env.ADMIN_PHONES || "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Revisa qué sucursales todavía no registraron nada hoy, y avisa si falta alguna. */
async function verificarSucursales() {
  if (Object.keys(SUCURSALES).length === 0 || ADMIN_PHONES.length === 0) return;

  try {
    const registrados = await obtenerTelefonosRegistradosHoy();
    const faltantes = Object.entries(SUCURSALES).filter(([telefono]) => !registrados.has(telefono));

    if (faltantes.length === 0) return; // todas mandaron algo hoy, no hace falta avisar

    const lista = faltantes.map(([, nombre]) => `• ${nombre}`).join("\n");
    const mensaje = `⚠️ Todavía no llegó ningún documento hoy de:\n\n${lista}`;

    for (const admin of ADMIN_PHONES) {
      await enviarMensajeTexto(admin, mensaje);
    }
  } catch (err) {
    console.error("Error al verificar sucursales:", err.message);
  }
}

// Corre todos los días a las 12:00 y a las 16:00, hora de Paraguay.
cron.schedule("0 12 * * *", verificarSucursales, { timezone: "America/Asuncion" });
cron.schedule("0 16 * * *", verificarSucursales, { timezone: "America/Asuncion" });

// --- SOLO PARA PROBAR: dispara el chequeo de sucursales manualmente ---
// Visitá https://tu-url-de-railway/test-verificar-sucursales?token=TU_VERIFY_TOKEN
// Una vez confirmado que funciona, se puede borrar esta ruta (no es necesaria
// para el funcionamiento normal del bot, que ya corre esto solo a las 12:00 y 16:00).
app.get("/test-verificar-sucursales", async (req, res) => {
  if (req.query.token !== WHATSAPP_VERIFY_TOKEN) return res.sendStatus(403);
  await verificarSucursales();
  res.send("Listo, revisá tu WhatsApp.");
});

app.listen(PORT, async () => {
  await asegurarEncabezados();
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
