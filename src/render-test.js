// Rend le faux ticket de démonstration en PDF (sans imprimante ni Firebase).
//   node src/render-test.js
//   node src/render-test.js --printer=pos80
const fs = require('fs/promises');
const path = require('path');
const { loadDotEnv, resolvePrinter } = require('./config');
const { renderTicketHtml } = require('./ticket');
const { htmlToPdf, closeBrowser } = require('./print');

loadDotEnv();

const fakeOrder = {
  id: 'TEST01abcdef',
  dailyOrderNumber: 42,
  customerName: 'Ticket de test',
  customerPhone: '06 12 34 56 78',
  fulfillmentMode: 'click_collect',
  paymentMethod: 'counter',
  paymentStatus: 'pending',
  createdAt: new Date(),
  items: [
    { itemId: 'a', name: 'Poke bowl saumon', qty: 1, category: 'plat', unitPriceCents: 1290,
      vatCategory: 'food_prepared_onsite', options: [{ label: 'Sauce: Ponzu', priceCents: 0 }] },
    { itemId: 'b', name: 'Cookie', qty: 2, category: 'dessert', unitPriceCents: 250, vatCategory: 'food_unprepared' },
    { itemId: 'c', name: 'Limonade', qty: 1, category: 'boisson', unitPriceCents: 350, vatCategory: 'beverage_sweetened' },
  ],
  subtotalCents: 2140,
  totalEurosCents: 2140,
};

const stubDb = { collection: () => ({ get: async () => ({ docs: [] }), doc: () => ({ collection: () => ({ get: async () => ({ docs: [] }) }) }) }) };

(async () => {
  const printer = resolvePrinter();
  const html = await renderTicketHtml(stubDb, fakeOrder, 'Merci et à bientôt chez FEEL’s !', { format: printer.format });
  const tmp = await htmlToPdf(html, 'demo', printer.format);
  const out = path.join(__dirname, '..', `ticket-test-${printer.key}.pdf`);
  await fs.copyFile(tmp, out);
  await fs.unlink(tmp).catch(() => {});
  await closeBrowser();
  console.log(`PDF généré (${printer.key}, ${printer.format}) :`, out);
})().catch((e) => { console.error(e); process.exit(1); });
