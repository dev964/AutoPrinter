// Aperçu local ESC/POS : rend un faux ticket, écrit le PNG (pour visualiser le
// rendu réel envoyé à l'imprimante) et affiche les infos de la trame ESC/POS.
// Usage : node scripts/escpos-preview.js [chemin_png]
process.env.PUPPETEER_EXECUTABLE_PATH ||= '/usr/bin/chromium';

const fs = require('fs');
const sharp = require('sharp');
const { renderTicketHtml } = require('../src/ticket');
const { htmlToPng, buildEscposRaster } = require('../src/escpos');
const { closeBrowser } = require('../src/print');

const out = process.argv[2] || '/tmp/escpos-preview.png';
const WIDTH_DOTS = Number(process.env.ESCPOS_WIDTH_DOTS || 576);

const fakeOrder = {
  id: 'TEST01abcdef', dailyOrderNumber: 42, customerName: 'Ticket de test',
  customerPhone: '06 12 34 56 78', fulfillmentMode: 'click_collect',
  paymentMethod: 'counter', paymentStatus: 'pending', createdAt: new Date(),
  items: [
    { itemId: 'a', name: 'Poke bowl saumon', qty: 1, category: 'plat', unitPriceCents: 1290, vatCategory: 'food_prepared_onsite', options: [{ label: 'Sauce: Ponzu', priceCents: 0 }] },
    { itemId: 'b', name: 'Cookie', qty: 2, category: 'dessert', unitPriceCents: 250, vatCategory: 'food_unprepared' },
    { itemId: 'c', name: 'Limonade', qty: 1, category: 'boisson', unitPriceCents: 350, vatCategory: 'beverage_sweetened' },
  ],
  subtotalCents: 2140, totalEurosCents: 2140,
};
const stubDb = { collection: () => ({ get: async () => ({ docs: [] }), doc: () => ({ collection: () => ({ get: async () => ({ docs: [] }) }) }) }) };

(async () => {
  const html = await renderTicketHtml(stubDb, fakeOrder, 'Merci et à bientôt chez FEEL’s !', { format: '80mm' });
  const png = await htmlToPng(html, WIDTH_DOTS);
  const meta = await sharp(png).metadata();
  fs.writeFileSync(out, png);
  const payload = await buildEscposRaster(png, { widthDots: WIDTH_DOTS });
  console.log(`PNG : ${meta.width}x${meta.height} px → ${out}`);
  console.log(`Hauteur papier ≈ ${(meta.height / (WIDTH_DOTS / 72) / 203 * 25.4).toFixed(1)} mm (à 203 dpi, ${WIDTH_DOTS} pts = 72 mm)`);
  console.log(`Trame ESC/POS : ${payload.length} octets`);
  console.log('Début (hex) :', payload.subarray(0, 12).toString('hex'));
  console.log('Fin   (hex) :', payload.subarray(-4).toString('hex'), '(coupe GS V 66 n)');
  await closeBrowser();
})().catch((e) => { console.error(e); process.exit(1); });
