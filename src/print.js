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

/** Rend le HTML en PDF et renvoie le chemin du fichier temporaire. */
async function htmlToPdf(html, basename, formatName = '100x150') {
  const fmt = getFormat(formatName);
  const widthIn = fmt.widthMm / 25.4;
  const heightIn = fmt.heightMm / 25.4;

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const file = path.join(os.tmpdir(), `feels-ticket-${basename}-${process.pid}.pdf`);
    await page.pdf({
      path: file,
      printBackground: true,
      width: `${widthIn}in`,
      height: `${heightIn}in`,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: true,
    });
    return file;
  } finally {
    await page.close();
  }
}

/** Envoie un PDF à l'imprimante via CUPS. */
async function lpPrint(pdfPath, printerName) {
  const args = ['-d', printerName, pdfPath];
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
  const pdf = await htmlToPdf(html, basename, format);
  try {
    return await lpPrint(pdf, printerName);
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
