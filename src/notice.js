// ─────────────────────────────────────────────────────────────────────────────
// Imprime UNE étiquette d'avertissement « serveur » (100×150 mm), à coller sur
// la machine. Contenu figé (pas de Firebase). Réutilise le moteur d'impression.
//
//   node src/notice.js                       # imprime sur PRINTER_NAME (déf. Munbyn)
//   node src/notice.js --dry                 # génère ./notice.pdf sans imprimer
//   node src/notice.js --dry --out=/x/y.pdf  # aperçu PDF vers un chemin précis
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { printHtml, htmlToPdf, closeBrowser } = require('./print');

const PRINTER_NAME = process.env.PRINTER_NAME || 'Munbyn';
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const out = (args.find((a) => a.startsWith('--out=')) || '').replace('--out=', '')
  || path.join(__dirname, '..', 'notice.pdf');

const WARN_SVG = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <path d="M50 6 L96 92 L4 92 Z" fill="none" stroke="#000" stroke-width="7" stroke-linejoin="round"/>
  <line x1="50" y1="36" x2="50" y2="68" stroke="#000" stroke-width="9" stroke-linecap="round"/>
  <circle cx="50" cy="83" r="5.5" fill="#000"/>
</svg>`;

const HTML = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Avertissement serveur</title>
<style>
  @page { size: 100mm 150mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; color: #000; background: #fff; }
  body {
    width: 100mm; height: 150mm; padding: 4mm;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    display: flex; flex-direction: column;
  }
  .frame { flex: 1; border: 1mm solid #000; border-radius: 2mm; padding: 4mm 3.5mm;
    display: flex; flex-direction: column; align-items: center; text-align: center; }
  .banner { width: 100%; background: #000; color: #fff; font-weight: 800;
    font-size: 7mm; letter-spacing: 0.6mm; padding: 2mm 0; border-radius: 1mm; }
  .tri { width: 26mm; height: 26mm; margin: 4mm 0 3mm; }
  .tri svg { width: 100%; height: 100%; display: block; }
  .lead { font-size: 6mm; font-weight: 800; line-height: 1.15; }
  .rule { width: 70%; border-top: 0.5mm solid #000; margin: 3.5mm 0; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { font-size: 4.6mm; font-weight: 700; line-height: 1.35; margin: 1.6mm 0; }
  li .x { font-weight: 900; margin-right: 1.5mm; }
  .foot { margin-top: auto; font-size: 3.2mm; font-weight: 700; opacity: 0.85;
    text-transform: uppercase; letter-spacing: 0.3mm; }
</style></head>
<body>
  <div class="frame">
    <div class="banner">⚠ ATTENTION ⚠</div>
    <div class="tri">${WARN_SVG}</div>
    <div class="lead">CECI EST UN SERVEUR</div>
    <div class="rule"></div>
    <ul>
      <li><span class="x">✕</span>NE PAS DÉBRANCHER</li>
      <li><span class="x">✕</span>NE PAS ÉTEINDRE</li>
      <li><span class="x">✕</span>PC NON UTILISABLE</li>
      <li><span class="x">✓</span>LAISSER LE CAPOT FERMÉ</li>
    </ul>
    <div class="foot">Service d'impression — FEEL's</div>
  </div>
</body></html>`;

(async () => {
  try {
    if (dry) {
      const pdf = await htmlToPdf(HTML, 'notice');
      fs.copyFileSync(pdf, out);
      fs.unlinkSync(pdf);
      console.log('PDF généré :', out);
    } else {
      const job = await printHtml(HTML, { printerName: PRINTER_NAME, basename: 'notice' });
      console.log(`Étiquette envoyée à « ${PRINTER_NAME} » → ${job}`);
    }
  } catch (e) {
    console.error('[notice] échec :', e.message);
    process.exitCode = 1;
  } finally {
    await closeBrowser().catch(() => {});
  }
})();
