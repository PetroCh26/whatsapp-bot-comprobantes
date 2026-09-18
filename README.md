# Bot de WhatsApp para archivar comprobantes en Google Sheets

Recibe fotos de comprobantes (transferencia, depósito, cheque, efectivo, factura, nota
de crédito, nota de remisión, remisión de combustible, recibo de dinero/viático) por
WhatsApp, extrae los datos automáticamente (cliente, RUC, factura, fecha, monto, ítems,
datos de transporte) y los guarda en una planilla de Google Sheets, dejando registro de
quién envió cada comprobante.

## 1. Probar la extracción de datos YA MISMO (sin WhatsApp)

Esto te deja ver si la lectura automática de tus comprobantes funciona bien, antes
de meterte con la configuración de WhatsApp.

```bash
npm install
cp .env.example .env
# completá al menos ANTHROPIC_API_KEY en .env

node test-local.js ./ruta/a/una/foto/de/comprobante.jpg
```

Vas a ver en consola el JSON con los datos extraídos. Cuando estés conforme,
seguí con los pasos de abajo para conectar Google Sheets y WhatsApp.

## 2. Configurar Google Sheets

1. Andá a [console.cloud.google.com](https://console.cloud.google.com), creá un proyecto.
2. Activá la "Google Sheets API".
3. Creá una "Service Account" (Cuenta de servicio) y descargá su clave JSON.
   Guardala como `service-account.json` en esta carpeta.
4. Creá una planilla nueva en Google Sheets, y compartila (botón "Compartir")
   con el email de la cuenta de servicio (algo como `xxx@xxx.iam.gserviceaccount.com`),
   dándole permiso de "Editor".
5. Copiá el ID de la planilla (está en la URL, entre `/d/` y `/edit`) y ponelo
   en `GOOGLE_SHEET_ID` del `.env`.
6. Poné el nombre de la pestaña/hoja (por defecto "Comprobantes") en `GOOGLE_SHEET_NAME`.

Podés probar esta parte con: `node test-local.js foto.jpg --guardar`

## 3. Configurar WhatsApp (Meta Cloud API)

1. Andá a [developers.facebook.com](https://developers.facebook.com) y creá una app
   de tipo "Business".
2. Agregale el producto "WhatsApp".
3. En "API Setup" vas a ver un número de prueba gratis, un `Temporary access token`
   y el `Phone number ID`. Copiá ambos al `.env`.
4. Inventá una palabra secreta para `WHATSAPP_VERIFY_TOKEN` (la que quieras).
5. Desplegá el servidor (ver paso 4) para tener una URL pública, y configurala
   en Meta como webhook: `https://tu-servidor.com/webhook`, con el mismo
   verify token. Suscribite al campo `messages`.
6. Agregá tu propio número como "destinatario de prueba" en Meta para poder
   mandarle fotos desde tu celular.

Nota: el token temporario de Meta expira en 24hs. Para producción hay que generar
un token permanente (Meta > System Users), es un paso más pero está bien documentado
en su panel.

## 4. Desplegar el servidor

Necesitás una URL pública para que Meta te pueda mandar los webhooks. Opciones
gratis/fáciles para empezar:

- **Railway** (railway.app): conectás este repo, agregás las variables del `.env`
  como "Variables" del proyecto, y listo.
- **Render** (render.com): similar, "Web Service" gratis para pruebas.

En ambos casos:
```bash
npm install
npm start
```
y configurás las variables de entorno desde el panel de la plataforma (no subas
tu `.env` ni tu `service-account.json` a git — agregalos a `.gitignore`).

## Estructura de la planilla generada

La planilla tiene 39 columnas (más "Estado"), agrupadas así:

- **Trazabilidad WhatsApp:** Fecha de registro, Registrado por, Nombre remitente.
- **Partes involucradas:** Tipo, Nombre cliente, RUC cliente, Nombre beneficiario,
  Cuenta origen, Cuenta destino, Concepto.
- **Documento y sus ítems:** Nro Documento, Condición de venta, Código ítem, Unidad
  de medida, Cantidad, Descripción ítem, Costo Unitario, Subtotal ítem.
- **Fechas y monto:** Fecha del comprobante, Fecha de pago, Monto total, Moneda.
- **Bancarios/cheques:** Banco/Entidad, Nro Operación/Cheque, Firmante, C.I. Firmante.
- **Facturación:** Emisor factura, RUC Emisor, Timbrado.
- **Transporte (notas de remisión):** Transportista, Chofer, C.I. Chofer, Vehículo,
  Matrícula, Dirección de salida, Dirección de entrega, Km recorrido, Motivo del
  traslado.
- **Resto:** Observaciones, Estado.

Esto te da la trazabilidad completa: **quién** mandó el comprobante por WhatsApp,
**quién paga y quién recibe** cada pago, todos los datos de cheques y facturas
desglosados, y el detalle completo de traslados de mercadería.

**Importante sobre documentos con ítems (facturas, notas de crédito, notas de
remisión):** si el documento tiene varios productos/servicios en su tabla, el sistema
genera **una fila por cada ítem**, repitiendo los datos del documento en cada una (mismo
número de documento). Por ejemplo, una factura con 2 productos genera 2 filas. El resto
de los documentos (transferencias, depósitos, cheques, efectivo) generan una sola fila.

## Próximas mejoras posibles (decime si querés que las sumemos)

- Guardar también la imagen original (ej. en Google Drive) con link en la planilla.
- Permitir corregir un dato mal leído respondiendo por WhatsApp.
- Detectar duplicados (mismo comprobante enviado dos veces).
- Panel web simple para revisar y aprobar los "Pendientes de revisión".
- **Rotación anual de la planilla** (pendiente, a futuro): Google Sheets soporta
  hasta 10 millones de celdas por archivo (~660.000 filas con las 15 columnas
  actuales). No es urgente hoy, pero cuando el volumen crezca conviene que el
  bot cree una pestaña o planilla nueva cada año (ej. "Comprobantes 2027") para
  que nunca se acerque al límite, o migrar a una base de datos real si el
  volumen se dispara (varias sucursales, mucho tráfico, etc).
