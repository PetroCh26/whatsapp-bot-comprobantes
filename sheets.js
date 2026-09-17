import { google } from "googleapis";

const SHEET_HEADERS = [
  "Fecha de registro",
  "Registrado por (WhatsApp)",
  "Nombre remitente (WhatsApp)",
  "Tipo de comprobante",
  "Nombre cliente",
  "RUC cliente",
  "Nombre beneficiario",
  "Cuenta origen",
  "Cuenta destino",
  "Concepto",
  "Nro Documento (Factura/N.Crédito/N.Remisión)",
  "Condición de venta",
  "Código ítem",
  "Unidad de medida",
  "Cantidad",
  "Descripción ítem",
  "Costo Unitario",
  "Subtotal ítem",
  "Fecha del comprobante",
  "Fecha de pago (cheque diferido)",
  "Monto (total documento)",
  "Moneda",
  "Banco / Entidad",
  "Nro Operación / Cheque",
  "Firmante",
  "C.I. Firmante",
  "Emisor factura",
  "RUC Emisor factura",
  "Timbrado",
  "Transportista",
  "Chofer",
  "C.I. Chofer",
  "Vehículo",
  "Matrícula vehículo",
  "Dirección de salida",
  "Dirección de entrega",
  "Km recorrido",
  "Motivo del traslado",
  "Observaciones",
  "Estado",
];

const ULTIMA_COLUMNA = "AN"; // 40 columnas: A hasta AN

async function getSheetsClient() {
  // En producción (Railway, Render, etc.) es más seguro pegar el contenido
  // completo del JSON de la cuenta de servicio en una variable de entorno,
  // en vez de subir el archivo. Si existe esa variable, la usamos; si no,
  // caemos al archivo local (como en desarrollo).
  const credencialesJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  const auth = credencialesJson
    ? new google.auth.GoogleAuth({
        credentials: JSON.parse(credencialesJson),
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      })
    : new google.auth.GoogleAuth({
        keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });

  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

/** Crea la fila de encabezados si la hoja está vacía. */
export async function asegurarEncabezados() {
  const sheets = await getSheetsClient();
  const range = `${process.env.GOOGLE_SHEET_NAME}!A1:${ULTIMA_COLUMNA}1`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range,
  });
  if (!res.data.values || res.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range,
      valueInputOption: "RAW",
      requestBody: { values: [SHEET_HEADERS] },
    });
  }
}

/** Construye la parte de la fila anterior a las columnas de ítem. */
function filaBase(datos, remitente, registro) {
  return [
    registro,
    remitente.telefono,
    remitente.nombre || "",
    datos.tipo_comprobante,
    datos.nombre_cliente,
    datos.ruc_cliente,
    datos.nombre_beneficiario,
    datos.cuenta_origen,
    datos.cuenta_destino,
    datos.concepto,
    datos.numero_factura,
    datos.condicion_venta,
  ];
}

/** Construye la parte de la fila posterior a las columnas de ítem. */
function filaResto(datos) {
  return [
    datos.fecha_comprobante,
    datos.fecha_pago,
    datos.monto,
    datos.moneda,
    datos.banco_o_entidad,
    datos.numero_operacion,
    datos.firmante,
    datos.ci_firmante,
    datos.emisor_factura,
    datos.ruc_emisor,
    datos.timbrado,
    datos.transportista,
    datos.chofer,
    datos.ci_chofer,
    datos.vehiculo,
    datos.matricula_vehiculo,
    datos.direccion_salida,
    datos.direccion_entrega,
    datos.km_recorrido,
    datos.motivo_traslado,
    datos.observaciones,
    "Pendiente de revisión",
  ];
}

/**
 * Agrega una o varias filas por cada comprobante detectado en la imagen.
 * Si un documento (factura/nota de crédito/nota de remisión) tiene varios
 * ítems, genera una fila por cada ítem, repitiendo los datos del documento.
 * @param {object[]} listaDatos - array de comprobantes extraídos por ocr.js
 * @param {object} remitente - { telefono, nombre }
 */
export async function guardarComprobante(listaDatos, remitente) {
  const sheets = await getSheetsClient();
  const registro = new Date().toISOString();
  const filas = [];

  for (const datos of listaDatos) {
    const base = filaBase(datos, remitente, registro);
    const resto = filaResto(datos);
    const items = Array.isArray(datos.items) ? datos.items : [];

    if (items.length === 0) {
      // Documento sin ítems (transferencia, cheque, depósito, etc.): una sola fila.
      filas.push([...base, null, null, null, null, null, null, ...resto]);
    } else {
      // Una fila por cada ítem, repitiendo los datos del documento.
      for (const item of items) {
        filas.push([
          ...base,
          item.codigo,
          item.unidad_medida,
          item.cantidad,
          item.descripcion,
          item.costo_unitario,
          item.subtotal_item,
          ...resto,
        ]);
      }
    }
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${process.env.GOOGLE_SHEET_NAME}!A:${ULTIMA_COLUMNA}`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: filas },
  });
}
