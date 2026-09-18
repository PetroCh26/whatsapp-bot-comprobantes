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

    const esImagen = message.type === "image";
    const esDocumentoPdf =
      message.type === "document" && message.document?.mime_type === "application/pdf";

    if (!esImagen && !esDocumentoPdf) {
      await enviarMensajeTexto(
        remitente.telefono,
        "Por favor enviá una *foto* o un *PDF* del comprobante (transferencia, depósito, cheque, efectivo o factura)."
      );
      return;
    }

    const mediaId = esImagen ? message.image.id : message.document.id;
    const { buffer, mediaType } = await descargarMedia(mediaId);

    const listaDatos = await extraerDatosComprobante(buffer, mediaType);
    await guardarComprobante(listaDatos, remitente);

    const resumen = construirResumen(listaDatos);
    await enviarMensajeTexto(remitente.telefono, resumen);
  } catch (err) {
    console.error("Error procesando mensaje:", err);
  }
});

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
        `${d.monto ?? "-"} ${d.moneda || ""} | Nro: ${d.numero_operacion || "-"}`
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
