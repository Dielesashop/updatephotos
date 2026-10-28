// Sube fotos de FOTOS/<ALMACEN>/<clave>.png a Supabase Storage
// y las registra en la tabla producto_imagenes.
// Uso: node subir-fotos.mjs
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FOTOS_DIR } = process.env;
const BUCKET = "productos";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !FOTOS_DIR) {
  console.error("Faltan variables en .env (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FOTOS_DIR)");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// 1. Cargar todas las claves existentes en la BD
async function cargarClaves() {
  const claves = new Set();
  const pagina = 1000;
  for (let desde = 0; ; desde += pagina) {
    const { data, error } = await supabase
      .from("productos")
      .select("clave")
      .range(desde, desde + pagina - 1);
    if (error) throw error;
    data.forEach((p) => claves.add(String(p.clave)));
    if (data.length < pagina) break;
  }
  return claves;
}

// 2. Detectar clave y orden a partir del nombre del archivo
//    2221      -> clave 2221, orden 1
//    2221_2    -> clave 2221, orden 2
function parsearNombre(base, claves) {
  if (claves.has(base)) return { clave: base, orden: 1 };
  const m = base.match(/^(.+)_(\d+)$/);
  if (m && claves.has(m[1])) return { clave: m[1], orden: Number(m[2]) };
  return null;
}

const rutaValida = (r) => /^[A-Za-z0-9_\-./]+$/.test(r);

async function main() {
  const claves = await cargarClaves();
  console.log(`Productos en BD: ${claves.size}`);

  const reporte = { subidas: 0, sinProducto: [], rutaInvalida: [], errores: [] };
  const clavesConFoto = new Set();

  const carpetas = (await fs.readdir(FOTOS_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const carpeta of carpetas) {
    const archivos = (await fs.readdir(path.join(FOTOS_DIR, carpeta))).filter((f) =>
      /\.(png|jpe?g|webp)$/i.test(f)
    );

    for (const archivo of archivos) {
      const base = path.parse(archivo).name;
      const rutaLocal = `${carpeta}/${archivo}`;

      const info = parsearNombre(base, claves);
      if (!info) {
        reporte.sinProducto.push(rutaLocal);
        continue;
      }

      const ruta = `${carpeta}/${base}.webp`;
      if (!rutaValida(ruta)) {
        reporte.rutaInvalida.push(rutaLocal);
        continue;
      }

      try {
        const buffer = await sharp(path.join(FOTOS_DIR, carpeta, archivo))
          .resize({ width: 1000, withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer();

        const { error: errSubida } = await supabase.storage
          .from(BUCKET)
          .upload(ruta, buffer, { contentType: "image/webp", upsert: true });
        if (errSubida) throw errSubida;

        const { error: errDb } = await supabase
          .from("producto_imagenes")
          .upsert({ clave: info.clave, ruta, orden: info.orden }, { onConflict: "ruta" });
        if (errDb) throw errDb;

        clavesConFoto.add(info.clave);
        reporte.subidas++;
        if (reporte.subidas % 25 === 0) console.log(`Subidas: ${reporte.subidas}`);
      } catch (e) {
        reporte.errores.push(`${rutaLocal}: ${e.message}`);
      }
    }
  }

  const sinFoto = [...claves].filter((c) => !clavesConFoto.has(c));

  console.log("\n===== REPORTE =====");
  console.log(`Fotos subidas: ${reporte.subidas}`);
  console.log(`Fotos sin producto en BD: ${reporte.sinProducto.length}`);
  reporte.sinProducto.slice(0, 20).forEach((x) => console.log("  -", x));
  console.log(`Fotos con nombre de ruta inválido: ${reporte.rutaInvalida.length}`);
  reporte.rutaInvalida.slice(0, 20).forEach((x) => console.log("  -", x));
  console.log(`Errores: ${reporte.errores.length}`);
  reporte.errores.slice(0, 20).forEach((x) => console.log("  -", x));
  console.log(`Productos sin foto: ${sinFoto.length}`);

  await fs.writeFile(
    "reporte-subida.json",
    JSON.stringify({ ...reporte, productosSinFoto: sinFoto }, null, 2)
  );
  console.log("\nReporte completo guardado en reporte-subida.json");
}

main().catch((e) => {
  console.error("Error fatal:", e);
  process.exit(1);
});