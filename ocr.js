import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EXTRACTION_PROMPT = `Sos un asistente que extrae datos de documentos de pago, facturación y traslado
paraguayos/latinoamericanos: transferencias bancarias, boletas de depósito, cheques,
recibos de efectivo, facturas/facturas virtuales, notas de crédito, o notas de remisión.

IMPORTANTE: la imagen puede contener UN SOLO documento o VARIOS documentos distintos
(por ejemplo, una foto con 2, 3 o 4 cheques fotografiados juntos, o varias boletas
apiladas). Identificá cada documento individual que aparezca en la imagen, aunque estén
repetidos o se parezcan entre sí — cada cheque, comprobante o factura con su propio
número cuenta como uno distinto.

Devolvé SOLO un array JSON (nada de texto antes o después, sin markdown), con un objeto
por cada documento encontrado, en este formato exacto. Si un dato no aparece, poné null.

[
  {
    "tipo_comprobante": "transferencia" | "deposito" | "cheque" | "efectivo" | "factura" | "nota_credito" | "nota_remision" | "remision_combustible" | "recibo_viatico" | "otro",
    "nombre_cliente": string | null,
    "ruc_cliente": string | null,
    "nombre_beneficiario": string | null,
    "cuenta_origen": string | null,
    "cuenta_destino": string | null,
    "concepto": string | null,
    "numero_factura": string | null,
    "condicion_venta": "contado" | "credito" | null,
    "items": [
      {
        "codigo": string | null,
        "unidad_medida": string | null,
        "cantidad": number | null,
        "descripcion": string | null,
        "costo_unitario": number | null,
        "subtotal_item": number | null
      }
    ],
    "fecha_comprobante": "YYYY-MM-DD" | null,
    "fecha_pago": "YYYY-MM-DD" | null,
    "monto": number | null,
    "moneda": "PYG" | "USD" | "otro" | null,
    "banco_o_entidad": string | null,
    "numero_operacion": string | null,
    "firmante": string | null,
    "ci_firmante": string | null,
    "emisor_factura": string | null,
    "ruc_emisor": string | null,
    "timbrado": string | null,
    "transportista": string | null,
    "chofer": string | null,
    "ci_chofer": string | null,
    "vehiculo": string | null,
    "matricula_vehiculo": string | null,
    "direccion_salida": string | null,
    "direccion_entrega": string | null,
    "km_recorrido": number | null,
    "motivo_traslado": string | null,
    "observaciones": string | null
  }
]

Reglas por tipo de documento:

- TRANSFERENCIAS: "nombre_cliente" es quien ENVÍA/PAGA el dinero (el remitente), no
  quien lo recibe. "nombre_beneficiario" es quien RECIBE el pago (a veces es tu propia
  empresa). "cuenta_origen" y "cuenta_destino" son los números de cuenta de cada lado.
  "concepto" es el motivo o referencia del pago si aparece.

- BOLETAS DE DEPÓSITO (efectivo o cheques físicos, sin cuenta de origen propia):
  "nombre_cliente" es el DEPOSITANTE (el nombre en "Firma del Depositante" o
  "Aclaración de Firma"), "ruc_cliente" es su número de documento/C.I. si aparece.
  "nombre_beneficiario" es el titular de la cuenta que recibe el depósito (ej. "Nota
  de crédito para la cuenta a nombre de..."). "cuenta_destino" es el número de esa
  cuenta. "numero_operacion" es el número de boleta de depósito (el número de
  comprobante impreso, suele estar arriba a la derecha). "monto" es el Total General
  depositado. Si el depósito incluye cheques además de efectivo, anotalo en "concepto"
  (ej. "Incluye cheques de otros bancos").

- CHEQUES: "nombre_cliente" es el beneficiario ("Páguese a la orden de..."), porque en un
  cheque generalmente quien te lo entrega es tu cliente. "numero_operacion" es el número
  de cheque. "firmante" es el nombre de quien firma el cheque, "ci_firmante" su cédula si
  aparece. "fecha_comprobante" es la fecha de emisión, "fecha_pago" la fecha de pago si es
  diferido. "cuenta_origen" es la cuenta del cheque. Los campos "firmante"/"ci_firmante"
  son EXCLUSIVOS de cheques: para cualquier otro tipo de documento dejalos siempre en null,
  aunque el depositante también haya firmado (esa firma ya se cubre con "nombre_cliente").

- EFECTIVO: completá lo que haya (monto, fecha, nombre si se menciona), el resto null.

- FACTURAS: "nombre_cliente" es el cliente facturado (a quien se le vende), "ruc_cliente"
  su RUC/cédula, "numero_factura" el número completo (ej. 001-001-0000410), "monto" el
  Total a Pagar, "fecha_comprobante" la fecha de emisión. "emisor_factura" es el nombre o
  razón social de quien EMITE la factura (el proveedor/vendedor), "ruc_emisor" su RUC, y
  "timbrado" el número de timbrado si aparece. "condicion_venta" es "contado" o "credito"
  según lo marcado en el documento. "items" es la lista de CADA línea de la tabla de
  productos/servicios: para cada una completá "codigo" (si tiene), "cantidad",
  "descripcion", "costo_unitario", y "subtotal_item" (el importe de esa línea, de la
  columna Exentas/Gravadas que corresponda). Si la factura tiene una sola línea, "items"
  igual debe ser un array con un solo elemento. Si no hay tabla de ítems legible, dejá
  "items" como un array vacío [].

- NOTAS DE CRÉDITO: funcionan como una factura pero en sentido inverso (un descuento,
  devolución o ajuste a favor del cliente). "nombre_cliente" es el cliente al que se le
  emite la nota de crédito, "ruc_cliente" su RUC/cédula. "numero_factura" es el número de
  la nota de crédito (ej. 008-001-0000465). "monto" es el Total de la operación / Total en
  Guaraníes. "concepto" es el motivo del ajuste (ej. la descripción de la línea, como
  "Descuentos"). "items" seguí la misma lógica que en facturas si hay una tabla de líneas.
  "emisor_factura" y "ruc_emisor" son quien EMITE la nota de crédito (tu propia empresa),
  "timbrado" su número de timbrado, "fecha_comprobante" la fecha de emisión.

- NOTAS DE REMISIÓN (traslado de mercadería, sin montos): "numero_factura" es el número
  de la nota de remisión (ej. 001-004-0000124). "nombre_cliente" y "ruc_cliente" son el
  DESTINATARIO de la mercadería. "emisor_factura" y "ruc_emisor" son quien emite la
  remisión. "fecha_comprobante" es la fecha y hora de emisión. "items" es la tabla de
  mercadería trasladada: completá "codigo", "unidad_medida" (ej. LT, UNI), "cantidad" y
  "descripcion" (dejá "costo_unitario" y "subtotal_item" en null, estos documentos no
  tienen precios). "transportista" es el nombre/razón social del transportista,
  "chofer" el nombre y apellido del chofer, "ci_chofer" su número de documento,
  "vehiculo" el tipo y marca (ej. "Camión Scania"), "matricula_vehiculo" su matrícula,
  "direccion_salida" y "direccion_entrega" las direcciones de origen y destino del
  traslado, "km_recorrido" los kilómetros estimados, "motivo_traslado" el motivo de
  emisión (ej. "Traslado por ventas"). Dejá "monto" y "moneda" en null, ya que estas
  notas no tienen valor monetario.

- REMISIÓN DE COMBUSTIBLE (ticket de una estación de servicio por combustible cargado a
  un vehículo de la empresa, con precio): "nombre_cliente" es la empresa a la que se le
  factura el combustible (ej. "TAPIRACUAI SA"), "ruc_cliente" su RUC. "emisor_factura" es
  la estación de servicio que emite el ticket (ej. "PETROCHACO GUARAMBARE"), "ruc_emisor"
  y "timbrado" si aparecen. "numero_factura" es el número de remisión (ej.
  000-038-0005037). "chofer" es el nombre del chofer, "vehiculo" el tipo/marca si
  aparece, "matricula_vehiculo" la chapa, "km_recorrido" el kilometraje registrado en el
  ticket (aunque sea el odómetro y no una distancia recorrida, usá igual este campo).
  "items" tiene una línea por cada combustible cargado: "descripcion" (ej. "Diesel S5"),
  "cantidad" (litros), "costo_unitario" (precio por litro), "subtotal_item". "monto" es
  el Total a Pagar. "concepto" incluí cualquier código de referencia manuscrito que
  aparezca (ej. "Cod 22"), útil para cruzar con el recibo de viático relacionado.

- RECIBO DE DINERO / VIÁTICO (comprobante de entrega de efectivo a un empleado, chofer o
  tercero, para gastos o viáticos): "nombre_cliente" es quien RECIBE el dinero (la
  persona que firma como "Aclaración", ej. el chofer), "ruc_cliente" su cédula si
  aparece. "nombre_beneficiario" es quien ENTREGA el dinero (la empresa que paga, del
  texto "Recibí(mos) de..."). "numero_operacion" es el número del recibo (arriba a la
  izquierda). "monto" es el importe en guaraníes. "concepto" es el texto de "en concepto
  de...", incluyendo cualquier código de referencia (ej. "Cod 22") para poder cruzarlo
  con la remisión de combustible relacionada. "fecha_comprobante" es la fecha del
  recibo.

Para cualquier documento que NO sea factura, nota de crédito, nota de remisión o
remisión de combustible, dejá "items" como un array vacío []. Para cualquier documento
que no sea factura o nota de crédito, dejá "condicion_venta" en null. Para cualquier
documento que no sea nota de remisión o remisión de combustible, dejá los campos de
transporte (transportista, chofer, ci_chofer, vehiculo, matricula_vehiculo,
direccion_salida, direccion_entrega, km_recorrido, motivo_traslado) en null.

Usá "observaciones" solo para datos sueltos que no encajen en ningún campo anterior.
Aunque solo haya un documento en la imagen, devolvé igual un array con un solo elemento.

ATENCIÓN CON LAS FECHAS: muchos documentos tienen fechas manuscritas o en sellos de
cajero, donde es fácil confundir un dígito del año (por ejemplo leer "2020" en vez de
"2026"). Fijate especialmente en el AÑO: mirá con cuidado cada trazo, y si hay un sello
con fecha impresa además de una fecha escrita a mano, priorizá el sello (es más
confiable). Si hay alguna duda razonable sobre un dígito, preferí la fecha que sea
más reciente y coherente con el resto del documento antes que una fecha muy vieja.`;

/**
 * Extrae datos estructurados de un archivo (imagen o PDF) que puede contener uno
 * o varios comprobantes/facturas.
 * @param {Buffer} fileBuffer - bytes del archivo
 * @param {string} mediaType - ej. "image/jpeg", "image/png", "application/pdf"
 * @returns {Promise<object[]>} lista de comprobantes detectados (uno o más)
 */
export async function extraerDatosComprobante(fileBuffer, mediaType) {
  const base64Data = fileBuffer.toString("base64");
  const esPdf = mediaType === "application/pdf";

  const contentBlock = esPdf
    ? { type: "document", source: { type: "base64", media_type: mediaType, data: base64Data } }
    : { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } };

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4000,
    messages: [
      {
        role: "user",
        content: [contentBlock, { type: "text", text: EXTRACTION_PROMPT }],
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const raw = textBlock ? textBlock.text.trim() : "[]";

  // Por si el modelo agrega ```json ... ``` a pesar de la instrucción
  const cleaned = raw.replace(/^```json\s*|```$/g, "").trim();

  const camposVacios = () => ({
    tipo_comprobante: "otro",
    nombre_cliente: null,
    ruc_cliente: null,
    nombre_beneficiario: null,
    cuenta_origen: null,
    cuenta_destino: null,
    concepto: null,
    numero_factura: null,
    condicion_venta: null,
    items: [],
    fecha_comprobante: null,
    fecha_pago: null,
    monto: null,
    moneda: null,
    banco_o_entidad: null,
    numero_operacion: null,
    firmante: null,
    ci_firmante: null,
    emisor_factura: null,
    ruc_emisor: null,
    timbrado: null,
    transportista: null,
    chofer: null,
    ci_chofer: null,
    vehiculo: null,
    matricula_vehiculo: null,
    direccion_salida: null,
    direccion_entrega: null,
    km_recorrido: null,
    motivo_traslado: null,
    observaciones: "No se pudo leer automáticamente. Revisar manualmente.",
  });

  try {
    const parsed = JSON.parse(cleaned);
    // Por si el modelo devuelve un objeto suelto en vez de un array de uno,
    // y completamos cualquier campo faltante con null para que nunca falte una clave.
    const lista = Array.isArray(parsed) ? parsed : [parsed];
    const normalizada = lista.map((item) => ({ ...camposVacios(), ...item }));
    return normalizada.length > 0 ? normalizada : [camposVacios()];
  } catch (err) {
    console.error("No se pudo parsear la respuesta de extracción:", raw);
    return [camposVacios()];
  }
}
