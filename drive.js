import { google } from "googleapis";

async function getDriveClient() {
  // Igual que en sheets.js: en producción es más seguro pegar el JSON de la
  // cuenta de servicio en una variable de entorno; en desarrollo local
  // caemos al archivo service-account.json.
  const credencialesJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  const auth = credencialesJson
    ? new google.auth.GoogleAuth({
        credentials: JSON.parse(credencialesJson),
        scopes: ["https://www.googleapis.com/auth/drive.file"],
      })
    : new google.auth.GoogleAuth({
        keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE,
        scopes: ["https://www.googleapis.com/auth/drive.file"],
      });

  const client = await auth.getClient();
  return google.drive({ version: "v3", auth: client });
}

/**
 * Sube un archivo (imagen o PDF) a la carpeta de Google Drive configurada, lo
 * hace accesible por link, y devuelve la URL para verlo.
 * @param {Buffer} buffer - contenido del archivo
 * @param {string} mediaType - ej. "image/jpeg", "application/pdf"
 * @param {string} nombreArchivo - nombre a usar en Drive
 * @returns {Promise<string|null>} el link para ver el archivo, o null si no
 *   se pudo subir (para no frenar el resto del flujo por este motivo).
 */
export async function subirFoto(buffer, mediaType, nombreArchivo) {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) return null; // si no está configurado, seguimos sin subir

  try {
    const drive = await getDriveClient();

    const { Readable } = await import("node:stream");
    const stream = Readable.from(buffer);

    const archivo = await drive.files.create({
      requestBody: {
        name: nombreArchivo,
        parents: [folderId],
      },
      media: {
        mimeType: mediaType,
        body: stream,
      },
      fields: "id, webViewLink",
    });

    const fileId = archivo.data.id;

    // Hacemos el archivo visible para cualquiera que tenga el link (no
    // listado públicamente, pero tampoco restringido a personas concretas).
    await drive.permissions.create({
      fileId,
      requestBody: { role: "reader", type: "anyone" },
    });

    return archivo.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;
  } catch (err) {
    console.error("No se pudo subir la foto a Google Drive:", err.message);
    return null; // no frenamos el registro del comprobante por esto
  }
}
