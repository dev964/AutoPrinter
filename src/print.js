// ─────────────────────────────────────────────────────────────────────────────
// Impression : HTML → PDF (Puppeteer / Chromium) → `lp` vers une file CUPS.
// Le format papier est dicté par le profil imprimante (100×150 ou 80 mm).
// ─────────────────────────────────────────────────────────────────────────────

const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const puppeteer = require('puppeteer');
const { getFormat } = require('./formats');

const execFileP = promisify(execFile);

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
  return browserPromise;
}

// Largeur de référence du design du ticket (cf. ticket.js). Le format papier
// est obtenu en mettant à l'échelle depuis cette largeur.
const DESIGN_WIDTH_MM = 100;
// Marge de coupe sous le contenu pour les rouleaux (évite de rogner la dernière
// ligne / laisse le massicot couper proprement).
const CUT_MARGIN_MM = 3;

/** Rend le HTML en PDF et renvoie le chemin du fichier temporaire. */
async function htmlToPdf(html, basename, formatName = '100x150') {
  const fmt = getFormat(formatName);
  // Largeur cible = zone IMPRIMABLE (souvent < papier), pour ne rien couper à
  // droite. Ajustable sans rebuild via ROLL_PRINT_WIDTH_MM. Le design (100 mm)
  // est mis à l'échelle dessus via l'option `scale` de Puppeteer.
  const targetWidthMm = Number(
    process.env.ROLL_PRINT_WIDTH_MM ?? fmt.printWidthMm ?? fmt.widthMm,
  );
  const scale = targetWidthMm / DESIGN_WIDTH_MM;

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const file = path.join(os.tmpdir(), `feels-ticket-${basename}-${process.pid}.pdf`);

    // Hauteur papier : fixe (étiquette pré-découpée) ou adaptée au contenu (rouleau).
    let heightMm = fmt.heightMm;
    if (fmt.continuous) {
      // Hauteur réelle du ticket (px CSS @96dpi), convertie en mm puis mise à l'échelle.
      const heightPx = await page.evaluate(() => {
        const el = document.querySelector('.ticket') || document.body;
        return Math.ceil(el.getBoundingClientRect().height);
      });
      heightMm = (heightPx * 25.4) / 96 * scale + CUT_MARGIN_MM;
    }

    await page.pdf({
      path: file,
      printBackground: true,
      width: `${targetWidthMm}mm`,
      height: `${heightMm}mm`,
      scale,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: false,
    });
    return { path: file, widthMm: targetWidthMm, heightMm };
  } finally {
    await page.close();
  }
}

/**
 * Envoie un PDF à l'imprimante via CUPS.
 * On impose un média `Custom` EXACTEMENT à la taille du PDF + marges à zéro :
 * sinon CUPS recadre/rétrécit le ticket dans un média par défaut plus grand
 * (d'où la marge en haut et sur les côtés). Options ajustables via LP_OPTIONS.
 * @param {string} pdfPath
 * @param {string} printerName
 * @param {{widthMm?: number, heightMm?: number}} [dims]
 */
async function lpPrint(pdfPath, printerName, dims = {}) {
  const args = ['-d', printerName];
  // Média `Custom` à la taille EXACTE du PDF → la HAUTEUR s'adapte au contenu
  // (comme un ticket texte), au lieu d'être bloquée sur une page fixe du driver.
  // NE JAMAIS forcer `-o PageSize=...` en plus via LP_OPTIONS : ça écrase ce
  // média Custom, refixe la hauteur (210 mm) et peut sortir des pages blanches.
  if (dims.widthMm && dims.heightMm) {
    args.push('-o', `media=Custom.${Math.round(dims.widthMm)}x${Math.round(dims.heightMm)}mm`);
  }
  // Marges nulles (supprime la marge ajoutée par le driver/CUPS quand honorées).
  args.push('-o', 'page-left=0', '-o', 'page-right=0', '-o', 'page-top=0', '-o', 'page-bottom=0');
  // Options `lp` propres à l'imprimante (FeedDist, Cutting…), sans rebuild.
  // NB : éviter PageSize ici (cf. ci-dessus).
  const extra = (process.env.LP_OPTIONS || '').trim();
  if (extra) args.push(...extra.split(/\s+/));
  args.push(pdfPath);
  const { stdout } = await execFileP('lp', args);
  return stdout.trim();
}

/**
 * Pipeline complet : HTML → PDF → impression.
 * @param {object} opts
 * @param {string} opts.printerName  Nom de la file CUPS
 * @param {string} [opts.format]     Clé format (100x150, 80mm)
 * @param {string} [opts.basename]
 */
async function printHtml(html, { printerName, format = '100x150', basename = 'ticket' }) {
  const { path: pdf, widthMm, heightMm } = await htmlToPdf(html, basename, format);
  try {
    return await lpPrint(pdf, printerName, { widthMm, heightMm });
  } finally {
    fs.unlink(pdf).catch(() => {});
  }
}

async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise;
    await b.close().catch(() => {});
    browserPromise = null;
  }
}

module.exports = { printHtml, htmlToPdf, closeBrowser };
