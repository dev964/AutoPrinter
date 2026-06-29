// ─────────────────────────────────────────────────────────────────────────────
// Impression : HTML → PDF (Puppeteer / Chromium, même moteur que Chrome pour un
// rendu identique à l'app) → `lp` vers la file CUPS de l'imprimante Munbyn.
//
// Puppeteer/Chromium reste lancé une seule fois (réutilisé entre impressions)
// pour éviter ~1 s de démarrage à chaque ticket.
// ─────────────────────────────────────────────────────────────────────────────

const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const puppeteer = require('puppeteer');

const execFileP = promisify(execFile);

// 100 × 150 mm convertis en pouces pour Puppeteer (1 in = 25.4 mm).
const PAGE_WIDTH_IN = 100 / 25.4;
const PAGE_HEIGHT_IN = 150 / 25.4;

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

/** Rend le HTML en PDF 100×150 mm et renvoie le chemin du fichier temporaire. */
async function htmlToPdf(html, basename) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const file = path.join(os.tmpdir(), `feels-ticket-${basename}-${process.pid}.pdf`);
    await page.pdf({
      path: file,
      printBackground: true,
      width: `${PAGE_WIDTH_IN}in`,
      height: `${PAGE_HEIGHT_IN}in`,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: true, // respecte le @page { size: 100mm 150mm }
    });
    return file;
  } finally {
    await page.close();
  }
}

/**
 * Envoie un PDF à l'imprimante via CUPS.
 * @param {string} pdfPath
 * @param {string} printerName  Nom de la file CUPS (env PRINTER_NAME)
 */
async function lpPrint(pdfPath, printerName) {
  // -d : file d'impression ; on laisse le média/format par défaut de la file
  // (à configurer une fois dans CUPS : média 100x150mm, marges 0).
  const args = ['-d', printerName, pdfPath];
  const { stdout } = await execFileP('lp', args);
  return stdout.trim(); // ex: "request id is Munbyn-42 (1 file(s))"
}

/**
 * Pipeline complet : HTML → PDF → impression. Nettoie le PDF temporaire.
 * @returns {Promise<string>} sortie de `lp` (id de job)
 */
async function printHtml(html, { printerName, basename = 'ticket' }) {
  const pdf = await htmlToPdf(html, basename);
  try {
    return await lpPrint(pdf, printerName);
  } finally {
    fs.unlink(pdf).catch(() => { /* best-effort */ });
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
