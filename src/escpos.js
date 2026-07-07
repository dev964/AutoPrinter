// ─────────────────────────────────────────────────────────────────────────────
// Impression ESC/POS brute pour rouleau thermique (POS80).
//
// Le driver CUPS/PDF de ces imprimantes impose une PAGE FIXE (d'où marge en haut,
// coupe au milieu, papier qui sort). On contourne en pilotant l'imprimante en
// direct :
//   1. HTML (même template) → PNG via Puppeteer, à la largeur imprimable exacte ;
//   2. PNG → trame monochrome 1-bit → commande raster ESC/POS `GS v 0` ;
//   3. avance papier + coupe partielle (`GS V`) ;
//   4. envoi BRUT à la file CUPS (`lp -o raw`), sans filtre/driver.
//
// Ainsi la hauteur suit EXACTEMENT le contenu et la coupe tombe juste après.
// ─────────────────────────────────────────────────────────────────────────────

const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const sharp = require('sharp');
const { getBrowser } = require('./print');

const execFileP = promisify(execFile);

// Largeur d'impression par défaut : 576 pts = 72 mm à 203 dpi (rouleau 80 mm).
const DEFAULT_WIDTH_DOTS = 576;
// Seuil de binarisation (0-255) : < seuil → point noir. Plus haut = plus de noir.
const DEFAULT_THRESHOLD = 180;
// Sur-échantillonnage du rendu avant réduction (texte/QR plus nets).
const RENDER_SCALE = 3;
// Découpage de la trame en bandes (certaines imprimantes limitent la hauteur
// d'une commande raster unique).
const BAND_ROWS = 128;

/**
 * Rend le HTML en PNG à la largeur d'impression cible.
 * On capture l'élément `.ticket` (pas toute la page) et on redimensionne à
 * `widthDots` : la hauteur suit le contenu.
 * @param {string} html
 * @param {number} widthDots  largeur finale en points imprimante
 * @returns {Promise<Buffer>} PNG
 */
async function htmlToPng(html, widthDots) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 800, height: 600, deviceScaleFactor: RENDER_SCALE });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const el = (await page.$('.ticket')) || page;
    const png = await el.screenshot({ type: 'png' });
    return Buffer.from(png);
  } finally {
    await page.close();
  }
}

/**
 * Convertit un PNG en trame ESC/POS complète (init + raster + avance + coupe).
 * @param {Buffer} pngBuffer
 * @param {object} [opts]
 * @param {number} [opts.widthDots]
 * @param {number} [opts.threshold]   seuil de binarisation 0-255
 * @param {number} [opts.cutFeedDots] avance papier (points) avant la coupe
 * @returns {Promise<Buffer>}
 */
async function buildEscposRaster(pngBuffer, opts = {}) {
  const widthDots = opts.widthDots || DEFAULT_WIDTH_DOTS;
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const cutFeedDots = opts.cutFeedDots ?? 24; // ~3 mm à 203 dpi

  // Largeur = multiple de 8 (1 octet = 8 points), niveaux de gris, pixels bruts.
  const bytesPerRow = Math.ceil(widthDots / 8);
  const alignedWidth = bytesPerRow * 8;
  const { data, info } = await sharp(pngBuffer)
    .flatten({ background: '#ffffff' }) // aplati la transparence sur blanc
    .resize({ width: alignedWidth, fit: 'contain', background: '#ffffff' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const rowBytes = Math.ceil(width / 8);

  // Empaquetage 1-bit, MSB en premier ; bit à 1 = point noir (encre).
  const raster = Buffer.alloc(rowBytes * height, 0);
  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    const outOff = y * rowBytes;
    for (let x = 0; x < width; x++) {
      if (data[rowOff + x] < threshold) {
        raster[outOff + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }

  const chunks = [Buffer.from([0x1b, 0x40])]; // ESC @ : réinitialise l'imprimante

  // Trame raster `GS v 0`, en bandes de BAND_ROWS lignes max.
  const xL = rowBytes & 0xff;
  const xH = (rowBytes >> 8) & 0xff;
  for (let y = 0; y < height; y += BAND_ROWS) {
    const rows = Math.min(BAND_ROWS, height - y);
    const header = Buffer.from([0x1d, 0x76, 0x30, 0x00, xL, xH, rows & 0xff, (rows >> 8) & 0xff]);
    const start = y * rowBytes;
    chunks.push(header, raster.subarray(start, start + rows * rowBytes));
  }

  // Avance papier + coupe partielle : GS V 66 n (avance n points puis coupe).
  chunks.push(Buffer.from([0x1d, 0x56, 0x42, cutFeedDots & 0xff]));

  return Buffer.concat(chunks);
}

/**
 * Pipeline complet ESC/POS : HTML → PNG → trame → `lp -o raw`.
 * @param {string} html
 * @param {object} opts
 * @param {string} opts.printerName  file CUPS (envoi brut)
 * @param {number} [opts.widthDots]
 * @param {string} [opts.basename]
 */
async function printEscpos(html, { printerName, widthDots, basename = 'ticket' }) {
  const width = Number(process.env.ESCPOS_WIDTH_DOTS ?? widthDots ?? DEFAULT_WIDTH_DOTS);
  const threshold = process.env.ESCPOS_THRESHOLD ? Number(process.env.ESCPOS_THRESHOLD) : undefined;
  const cutFeedDots = process.env.ESCPOS_CUT_FEED_DOTS ? Number(process.env.ESCPOS_CUT_FEED_DOTS) : undefined;

  const png = await htmlToPng(html, width);
  const payload = await buildEscposRaster(png, { widthDots: width, threshold, cutFeedDots });

  const file = path.join(os.tmpdir(), `feels-escpos-${basename}-${process.pid}-${Date.now()}.bin`);
  await fs.writeFile(file, payload);
  try {
    // `-o raw` : bytes envoyés tels quels au backend (pas de filtre/driver PDF).
    const { stdout } = await execFileP('lp', ['-d', printerName, '-o', 'raw', file]);
    return stdout.trim();
  } finally {
    fs.unlink(file).catch(() => {});
  }
}

module.exports = { printEscpos, htmlToPng, buildEscposRaster };
