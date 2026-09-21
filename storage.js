import { Storage } from "@google-cloud/storage";

function getStorageClient() {
  // Igual que en sheets.js: en producción es más seguro pegar el JSON de la
  // cuenta de servicio en una variable de entorno; en desarrollo local
  // caemos al archivo service-account.json.
  const credencialesJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  return credencialesJson
    ? new Storage({ credentials: JSON.parse(credencialesJson) })
    : new Storage({ keyFilename: process.env.GOOGLE_SERVICE_ACCOUNT_FILE });
}

/**
 * Sube un archivo (imagen o PDF) al bucket de Google Cloud Storage
 * configurado, y devuelve la URL pública para verlo.
 * @param {Buffer} buffer - contenido del archivo
 * @param {string} mediaType - ej. "image/jpeg", "application/pdf"
 * @param {string} nombreArchivo - nombre a usar en el bucket
 * @returns {Promise<string|null>} el link para ver el archivo, o null si no
 *   se pudo subir (para no frenar el resto del flujo por este motivo).
 */
export async function subirFoto(buffer, mediaType, nombreArchivo) {
  const bucketName = process.env.GOOGLE_CLOUD_STORAGE_BUCKET;
  if (!bucketName) return null; // si no está configurado, seguimos sin subir

  try {
    const storage = getStorageClient();
    const bucket = storage.bucket(bucketName);
    const archivo = bucket.file(nombreArchivo);

    await archivo.save(buffer, {
      contentType: mediaType,
      resumable: false,
      predefinedAcl: "publicRead",
    });

    return `https://storage.googleapis.com/${bucketName}/${encodeURIComponent(nombreArchivo)}`;
  } catch (err) {
    console.error("No se pudo subir la foto a Google Cloud Storage:", err.message);
    return null; // no frenamos el registro del comprobante por esto
  }
}
