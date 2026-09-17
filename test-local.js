// Prueba local: node test-local.js ./ruta/a/tu/comprobante.jpg
// Extrae los datos con IA y los muestra en consola. Si pasás --guardar,
// también los agrega a tu Google Sheet.
import "dotenv/config";
import fs from "fs";
import path from "path";
import { extraerDatosComprobante } from "./ocr.js";
import { guardarComprobante, asegurarEncabezados } from "./sheets.js";

const rutaImagen = process.argv[2];
const guardar = process.argv.includes("--guardar");

if (!rutaImagen) {
  console.error("Uso: node test-local.js ./comprobante.jpg [--guardar]");
  process.exit(1);
}

const mediaTypes = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".pdf": "application/pdf",
};
const ext = path.extname(rutaImagen).toLowerCase();
const mediaType = mediaTypes[ext];
if (!mediaType) {
  console.error("Formato no soportado. Usá .jpg, .jpeg, .png o .pdf");
  process.exit(1);
}

const buffer = fs.readFileSync(rutaImagen);

console.log("Analizando imagen...");
const listaDatos = await extraerDatosComprobante(buffer, mediaType);
console.log(
  `\nSe detectaron ${listaDatos.length} comprobante(s) en la imagen:\n`,
  JSON.stringify(listaDatos, null, 2)
);

if (guardar) {
  await asegurarEncabezados();
  await guardarComprobante(listaDatos, { telefono: "test-local", nombre: "Prueba local" });
  console.log(`\n✅ Guardadas ${listaDatos.length} fila(s) en Google Sheets.`);
}
