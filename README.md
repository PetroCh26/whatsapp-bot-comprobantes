Bot de WhatsApp para archivar comprobantes en Google Sheets
Recibe fotos de comprobantes (transferencia, depósito, cheque, efectivo, factura, nota
de crédito, nota de remisión, remisión de combustible, recibo de dinero/viático,
lectura de surtidor) por WhatsApp, extrae los datos automáticamente (cliente, RUC,
factura, fecha, monto, ítems, datos de transporte) y los guarda en una planilla de
Google Sheets, dejando registro de quién envió cada comprobante.
1. Probar la extracción de datos YA MISMO (sin WhatsApp)
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
2. Configurar Google Sheets
Andá a console.cloud.google.com, creá un proyecto.
Activá la "Google Sheets API".
Creá una "Service Account" (Cuenta de servicio) y descargá su clave JSON.
Guardala como `service-account.json` en esta carpeta.
Creá una planilla nueva en Google Sheets, y compartila (botón "Compartir")
con el email de la cuenta de servicio (algo como `xxx@xxx.iam.gserviceaccount.com`),
dándole permiso de "Editor".
Copiá el ID de la planilla (está en la URL, entre `/d/` y `/edit`) y ponelo
en `GOOGLE_SHEET_ID` del `.env`.
Poné el nombre de la pestaña/hoja (por defecto "Comprobantes") en `GOOGLE_SHEET_NAME`.
Podés probar esta parte con: `node test-local.js foto.jpg --guardar`
2.1 Configurar Google Cloud Storage (opcional, para guardar la foto original)
Si querés que cada fila de la planilla tenga un link a la foto/PDF original del
comprobante. No uses Google Drive para esto: las cuentas de servicio no tienen
cuota de almacenamiento propia ahí (solo en Drive compartido, que es de Google
Workspace pago), así que Cloud Storage es la opción que sí funciona con una cuenta
Gmail normal, y tiene una capa gratuita de 5 GB/mes.
En console.cloud.google.com, dentro del mismo
proyecto, buscá "Cloud Storage" y activá la API si te lo pide.
Si todavía no tenés una cuenta de facturación vinculada al proyecto, te va a pedir
crear una — es gratis dar de alta, y no te cobra nada mientras te mantengas dentro
de la capa gratuita (5 GB de almacenamiento, uso normal de un bot como este está
muy por debajo de eso).
Andá a "Cloud Storage" > "Buckets" > "Crear". Elegí un nombre único (por ejemplo
`tuempresa-comprobantes-whatsapp`), dejá el resto de las opciones por defecto, y
creá el bucket. Importante: cuando te pregunte por "Prevención de acceso
público" (Public access prevention), dejala DESACTIVADA — si queda activada, los
links a las fotos van a dar error aunque todo lo demás esté bien configurado.
Dentro del bucket, pestaña "Permisos", agregá el email de tu cuenta de servicio
(el mismo que ya usás para Sheets, termina en `.iam.gserviceaccount.com`) con el
rol "Storage Object Admin".
Copiá el nombre exacto del bucket y ponelo en `GOOGLE_CLOUD_STORAGE_BUCKET` del
`.env`.
Las fotos quedan accesibles para cualquiera que tenga el link (no aparecen en
búsquedas ni son públicas de otra forma, pero el link en sí no pide login). Si más
adelante se necesita restringirlo a personas específicas, se puede ajustar.
Si no configurás esto, el bot sigue funcionando exactamente igual, solo que la columna
"Foto" queda vacía.
3. Configurar WhatsApp (Meta Cloud API)
Andá a developers.facebook.com y creá una app
de tipo "Business".
Agregale el producto "WhatsApp".
En "API Setup" vas a ver un número de prueba gratis, un `Temporary access token`
y el `Phone number ID`. Copiá ambos al `.env`.
Inventá una palabra secreta para `WHATSAPP_VERIFY_TOKEN` (la que quieras).
Desplegá el servidor (ver paso 4) para tener una URL pública, y configurala
en Meta como webhook: `https://tu-servidor.com/webhook`, con el mismo
verify token. Suscribite al campo `messages`.
Agregá tu propio número como "destinatario de prueba" en Meta para poder
mandarle fotos desde tu celular.
Nota: el token temporario de Meta expira en 24hs. Para producción hay que generar
un token permanente (Meta > System Users), es un paso más pero está bien documentado
en su panel.
4. Desplegar el servidor
Necesitás una URL pública para que Meta te pueda mandar los webhooks. Opciones
gratis/fáciles para empezar:
Railway (railway.app): conectás este repo, agregás las variables del `.env`
como "Variables" del proyecto, y listo.
Render (render.com): similar, "Web Service" gratis para pruebas.
En ambos casos:
```bash
npm install
npm start
```
y configurás las variables de entorno desde el panel de la plataforma (no subas
tu `.env` ni tu `service-account.json` a git — agregalos a `.gitignore`).
Corregir un dato después de guardarlo
Después de que el bot guarda un comprobante, tenés 15 minutos para corregir algún
dato escribiendo en lenguaje natural, por ejemplo: "el monto era 5.000.000, no
500.000" o "el cliente en realidad es Petrochaco". El bot interpreta el pedido,
actualiza las mismas filas que ya había guardado en la planilla (no crea filas
nuevas), y te confirma cómo quedó todo. Podés seguir corrigiendo mientras estés dentro
de esa ventana de 15 minutos; cada corrección la reinicia.
Si mandás una foto nueva antes de corregir la anterior, se pierde la posibilidad de
corregir esa (queda disponible para corregir la más reciente).
Aviso diario si alguna sucursal no mandó nada
Si configurás `SUCURSALES_JSON` y `ADMIN_PHONES` en las variables de entorno, el bot
revisa automáticamente dos veces al día (12:00 y 16:00, hora de Paraguay) si cada
sucursal ya mandó al menos un documento ese día. Si a alguna le falta, te avisa por
WhatsApp con la lista de sucursales pendientes. Si todas ya mandaron algo, no manda
ningún mensaje (para no generar ruido innecesario).
`SUCURSALES_JSON` es un mapa de número de WhatsApp → nombre de sucursal, por ejemplo:
```
{"595984548891":"Estación Remanso","595992639960":"Estación Pa'i Ñu"}
```
`ADMIN_PHONES` son los números a los que avisar (separados por coma si son varios).
Por defecto alcanza con que la sucursal haya mandado cualquier documento ese día.
Si necesitás que mande tipos específicos (por ejemplo, una lectura de surtidor Y un
comprobante de transferencia, no cualquiera de los dos), configurá `REQUISITOS_DIARIOS`
con los tipos separados por coma, usando los nombres internos: `transferencia`,
`deposito`, `cheque`, `efectivo`, `factura`, `nota_credito`, `nota_remision`,
`remision_combustible`, `recibo_viatico`, `lectura_surtidor`. El aviso entonces dice
puntualmente qué le falta a cada sucursal, por ejemplo:
```
⚠️ Pendientes de hoy:

• Estación Remanso: falta Lectura de surtidor
```
Para agregar o sacar una sucursal, cambiar a quién le llega el aviso, o ajustar qué
tipos son obligatorios, alcanza con editar esas variables en Railway — no hace falta
tocar código.
Chequeo manual: cualquiera de los números en `ADMIN_PHONES` puede escribirle
"verificar sucursales" al bot en cualquier momento para correr el chequeo al instante,
sin esperar a las 12:00 o 16:00. A diferencia del chequeo automático (que solo avisa
si falta algo, para no generar ruido), el manual siempre responde, incluso con un
"✅ Todas las sucursales ya mandaron lo que corresponde hoy" cuando está todo en orden.
Fecha de registro en hora de Paraguay
La columna "Fecha de registro" guarda la fecha y hora en la que WhatsApp recibió la
foto, ya convertida a hora de Paraguay y en formato legible (`YYYY-MM-DD HH:mm:ss`,
ej. `2026-09-23 16:48:23`) — no hace falta restarle horas a mano como con un timestamp
UTC. El formato se eligió así (año-mes-día) para que la planilla la pueda ordenar
correctamente de más vieja a más nueva.
Trazabilidad por sucursal en cualquier documento
No solo para "Lectura de surtidor": si el número que manda cualquier comprobante
(transferencia, factura, cheque, etc.) está en `SUCURSALES_JSON`, la columna
"Estación" de la planilla se completa automáticamente con el nombre de esa sucursal,
sin que nadie tenga que escribirlo ni elegirlo. Así queda registro de qué sucursal
mandó cada documento, sea del tipo que sea.
Sub-flujo especial: Lectura de surtidor
Al elegir "Lectura de surtidor" en el menú, el bot primero revisa si ya sabe de qué
sucursal es ese número (según `SUCURSALES_JSON`): si lo reconoce, salta directo al
mini-menú de combustible sin preguntar nada. Si el número no está en la lista de
sucursales conocidas, pregunta la estación como texto libre antes de mostrar el
menú de combustible. En ambos casos, el mini-menú para elegir el tipo de
combustible (Común 89, Especial 93, Súper 97, Diesel, Ultra, Alcohol) es igual.
Recién con esos dos datos completos habilita mandar la foto del contador del pico. La
estación y el combustible elegidos se guardan junto con el número de pico y la lectura
que lee la IA de la foto.
Flujo guiado por menú (obligatorio)
El bot ahora exige pasar por el menú antes de aceptar una foto: si alguien manda
una foto sin haber elegido antes una opción, el bot la rechaza y muestra el menú. Cada
elección del menú habilita todas las fotos que lleguen durante los próximos 2
minutos (se pueden mandar varias seguidas del mismo tipo). La excepción es "Lectura
de surtidor": ahí cada foto necesita su propia estación y combustible, así que la
elección vale para una sola foto.
Si se mandan varias fotos juntas, el bot las procesa una por una, en orden. Si
alguna necesita una pregunta de seguimiento (por ejemplo, a qué factura corresponde una
transferencia), las siguientes esperan en cola hasta que se responda, y el menú vuelve
a aparecer una sola vez al terminar con todas. Meta puede agrupar varias fotos en un
único aviso al servidor: el bot recorre todos los mensajes del aviso, no solo el primero.
Las opciones del menú están agrupadas en categorías (no una por cada uno de los 10
tipos de documento, porque WhatsApp permite máximo 10 filas en un menú de lista): Comprobante de pago (transferencia/depósito/cheque/efectivo), Factura/Nota de crédito,
Nota de remisión (mercadería o combustible), Recibo de viático, Lectura de surtidor, y
Finalizar. La detección del tipo EXACTO de documento la sigue haciendo la IA
automáticamente a partir de la imagen, sin importar cuál categoría general se eligió en
el menú — el menú es solo para guiar la interacción, no cambia qué tan bien se lee la
foto.
Después de guardar cada comprobante (ya sea directo, o tras responder preguntas de
seguimiento), el bot manda el resumen completo y automáticamente vuelve a mostrar el
menú, así la persona puede seguir registrando o elegir "Finalizar" para cerrar.
Preguntas de seguimiento por WhatsApp
Cuando alguien manda una foto de un comprobante de pago (transferencia, depósito,
cheque o efectivo) y la imagen no trae el número de factura al que corresponde, el bot
le pregunta por WhatsApp antes de guardar: "¿a qué número de factura corresponde?".
Si la foto tiene varios comprobantes, pregunta uno por uno. Si la persona no sabe,
puede responder "no" y el dato queda vacío (para completarlo después a mano en la
planilla).
Si mandás varias fotos seguidas desde el mismo número, el bot las procesa una por
una, en orden (no en paralelo), para nunca perder ni mezclar datos entre ellas. Si
mandás una foto nueva mientras todavía hay una pregunta pendiente de otra foto anterior,
el bot te avisa que la dejó en espera, y la procesa automáticamente apenas termines de
responder la anterior.
Esto vive en la memoria del servidor mientras dura la conversación: si el servidor se
reinicia (por ejemplo al desplegar un cambio) justo mientras alguien está respondiendo
una pregunta o tiene fotos en espera, esa conversación y esa cola se pierden y hay que
volver a mandar las fotos. Para el volumen de uso actual esto es aceptable; si en el
futuro se necesita que sea más robusto, se puede guardar el estado en la propia
planilla o en una base de datos en vez de en memoria.
Se puede sumar más preguntas fácilmente (por ejemplo, pedir el RUC del cliente si falta)
editando la función `construirPreguntas` en `server.js`.
Estructura de la planilla generada
La planilla tiene 39 columnas (más "Estado"), agrupadas así:
Trazabilidad WhatsApp: Fecha de registro, Registrado por, Nombre remitente.
Partes involucradas: Tipo, Nombre cliente, RUC cliente, Nombre beneficiario,
Cuenta origen, Cuenta destino, Concepto.
Documento y sus ítems: Nro Documento, Condición de venta, Código ítem, Unidad
de medida, Cantidad, Descripción ítem, Costo Unitario, Subtotal ítem.
Fechas y monto: Fecha del comprobante, Fecha de pago, Monto total, Moneda.
Bancarios/cheques: Banco/Entidad, Nro Operación/Cheque, Firmante, C.I. Firmante.
Facturación: Emisor factura, RUC Emisor, Timbrado.
Transporte (notas de remisión): Transportista, Chofer, C.I. Chofer, Vehículo,
Matrícula, Dirección de salida, Dirección de entrega, Km recorrido, Motivo del
traslado.
Resto: Observaciones, Estado.
Esto te da la trazabilidad completa: quién mandó el comprobante por WhatsApp,
quién paga y quién recibe cada pago, todos los datos de cheques y facturas
desglosados, y el detalle completo de traslados de mercadería.
Importante sobre documentos con ítems (facturas, notas de crédito, notas de
remisión): si el documento tiene varios productos/servicios en su tabla, el sistema
genera una fila por cada ítem, repitiendo los datos del documento en cada una (mismo
número de documento). Por ejemplo, una factura con 2 productos genera 2 filas. El resto
de los documentos (transferencias, depósitos, cheques, efectivo) generan una sola fila.
Próximas mejoras posibles (decime si querés que las sumemos)
Guardar también la imagen original (ej. en Google Drive) con link en la planilla.
Permitir corregir un dato mal leído respondiendo por WhatsApp.
Detectar duplicados (mismo comprobante enviado dos veces).
Panel web simple para revisar y aprobar los "Pendientes de revisión".
Rotación anual de la planilla (pendiente, a futuro): Google Sheets soporta
hasta 10 millones de celdas por archivo (~660.000 filas con las 15 columnas
actuales). No es urgente hoy, pero cuando el volumen crezca conviene que el
bot cree una pestaña o planilla nueva cada año (ej. "Comprobantes 2027") para
que nunca se acerque al límite, o migrar a una base de datos real si el
volumen se dispara (varias sucursales, mucho tráfico, etc).
Verificación del negocio en Meta (pendiente): hoy el bot solo puede recibir
fotos de los números agregados manualmente como "destinatarios de prueba" en el
panel de Meta. Para que CUALQUIER cliente pueda mandar comprobantes, hace falta
completar "Paso 3: Verificación del negocio" en developers.facebook.com y pasar
la app a modo producción con un número de WhatsApp Business real.
Columna separada para "Número de Cheque" (pendiente, a decidir): quedó
pendiente definir si conviene separar el número de cheque de la columna
compartida "Nro Operación / Cheque" (que hoy también usan transferencias y
depósitos), para que cada tipo de documento tenga su propia columna clara.
