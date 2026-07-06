// ─────────────────────────────────────────────────────────────────────────────
// Service d'auto-impression cuisine FEEL's.
//
// Écoute Firestore (collection `foodOrders`) et imprime le ticket client sur
// l'imprimante CUPS active (configurable, voir PRINTERS / ACTIVE_PRINTER).
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const admin = require('firebase-admin');
const { loadDotEnv, resolvePrinter, listPrinterProfiles } = require('./config');
const { isOrderConfirmed } = require('./lib');
const { renderTicketHtml } = require('./ticket');
const { printHtml, closeBrowser } = require('./print');

loadDotEnv();

const SERVICE_ACCOUNT_PATH =
  process.env.SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS;
const KITCHEN_OPERATOR_ID = process.env.KITCHEN_OPERATOR_ID;
const PRINT_DELAY_MS = Number(process.env.PRINT_DELAY_MS ?? 1200);

const ACTIVE_STATUSES = ['pending', 'accepted', 'preparing', 'ready_for_assembly'];

// ── File d'impression sérialisée (une impression à la fois) ──────────────────
const printQueue = [];
let draining = false;

function getActivePrinter() {
  return resolvePrinter();
}

async function drainQueue(db, getDailyMessage) {
  if (draining) return;
  draining = true;
  const printer = getActivePrinter();
  try {
    while (printQueue.length) {
      const order = printQueue.shift();
      try {
        const html = await renderTicketHtml(db, order, getDailyMessage(), { format: printer.format });
        const jobId = await printHtml(html, {
          printerName: printer.cupsName,
          format: printer.format,
          basename: order.id.slice(0, 6),
        });
        console.log(`[print] ✅ ${labelOf(order)} → ${printer.key} (${printer.cupsName}) ${jobId}`);
      } catch (err) {
        console.error(`[print] ❌ ${labelOf(order)} :`, err.message);
      }
      if (printQueue.length) await sleep(PRINT_DELAY_MS);
    }
  } finally {
    draining = false;
  }
}

function labelOf(o) {
  const num = typeof o.dailyOrderNumber === 'number' ? `N°${o.dailyOrderNumber}` : `#${o.id.slice(0, 6)}`;
  return `${num} ${o.customerName ?? 'Client'}`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isTestOrder(o) {
  if (o.isTestOrder) return true;
  return (o.customerName ?? '').trim().toLowerCase() === 'test';
}

// ── Démarrage ────────────────────────────────────────────────────────────────
async function main() {
  if (process.argv.includes('--test-print')) return testPrint();
  if (process.argv.includes('--list-printers')) return listPrinters();

  if (process.argv.includes('--check-config')) {
    console.log('SERVICE_ACCOUNT_PATH =', SERVICE_ACCOUNT_PATH || '(manquant)');
    console.log('KITCHEN_OPERATOR_ID  =', KITCHEN_OPERATOR_ID || '(manquant)');
    try {
      const p = getActivePrinter();
      console.log('ACTIVE_PRINTER       =', p.key, `→ ${p.cupsName} (${p.format})`);
    } catch (e) {
      console.log('ACTIVE_PRINTER       =', e.message);
    }
    console.log('clé lisible ?        =', SERVICE_ACCOUNT_PATH ? fs.existsSync(SERVICE_ACCOUNT_PATH) : false);
    return;
  }

  if (!SERVICE_ACCOUNT_PATH) fail('SERVICE_ACCOUNT_PATH manquant (clé service account JSON).');
  if (!KITCHEN_OPERATOR_ID) fail('KITCHEN_OPERATOR_ID manquant (id de la cuisine à écouter).');
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) fail(`Clé introuvable : ${SERVICE_ACCOUNT_PATH}`);

  let printer;
  try {
    printer = getActivePrinter();
  } catch (e) {
    fail(e.message);
  }

  const serviceAccount = require(require('path').resolve(SERVICE_ACCOUNT_PATH));
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  console.log(`[init] projet=${serviceAccount.project_id} opérateur=${KITCHEN_OPERATOR_ID} imprimante=${printer.key} (${printer.cupsName}, ${printer.format})`);

  let dailyLabelMessage = '';
  db.collection('kitchenOperators').doc(KITCHEN_OPERATOR_ID).onSnapshot(
    (snap) => { dailyLabelMessage = snap.data()?.dailyLabelMessage ?? ''; },
    (err) => console.warn('[init] message du jour indisponible :', err.message),
  );

  const query = db.collection('foodOrders')
    .where('kitchenOperatorId', '==', KITCHEN_OPERATOR_ID)
    .where('status', 'in', ACTIVE_STATUSES)
    .orderBy('createdAt', 'asc');

  const seen = new Set();
  let seeded = false;

  query.onSnapshot(
    (snap) => {
      const orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

      if (!seeded) {
        for (const o of orders) seen.add(o.id);
        seeded = true;
        console.log(`[watch] amorçage : ${orders.length} commande(s) active(s) ignorée(s) (déjà là).`);
        return;
      }

      for (const o of orders) {
        if (seen.has(o.id)) continue;
        if (isTestOrder(o)) { seen.add(o.id); continue; }
        if (!isOrderConfirmed(o)) continue;
        seen.add(o.id);
        console.log(`[watch] 🆕 ${labelOf(o)} → impression`);
        printQueue.push(o);
        void drainQueue(db, () => dailyLabelMessage);
      }
    },
    (err) => console.error('[watch] erreur snapshot :', err.code, err.message),
  );

  console.log('[watch] en écoute des nouvelles commandes… (Ctrl+C pour arrêter)');

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      console.log(`\n[exit] ${sig} — fermeture.`);
      await closeBrowser();
      process.exit(0);
    });
  }
}

function listPrinters() {
  const profiles = listPrinterProfiles();
  if (profiles.size === 0) {
    console.log('Aucun profil (définir PRINTERS ou PRINTER_NAME dans .env).');
    return;
  }
  let active;
  try { active = getActivePrinter().key; } catch { active = null; }
  console.log('Profils imprimantes :');
  for (const [key, p] of profiles) {
    const mark = key === active ? ' ← active' : '';
    console.log(`  ${key}\t${p.cupsName}\t${p.format}${mark}`);
  }
  console.log('\nChanger : ACTIVE_PRINTER=<clé> dans .env puis restart, ou --printer=<clé> en CLI.');
}

async function testPrint() {
  const printer = getActivePrinter();
  console.log(`[test] génération d’un ticket de démonstration (${printer.key} / ${printer.cupsName})…`);
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
  const html = await renderTicketHtml(stubDb, fakeOrder, 'Merci et à bientôt chez FEEL’s !', { format: printer.format });
  const job = await printHtml(html, { printerName: printer.cupsName, format: printer.format, basename: 'test' });
  console.log(`[test] envoyé à « ${printer.cupsName} » → ${job}`);
  await closeBrowser();
}

function fail(msg) {
  console.error(`[config] ${msg}`);
  process.exit(1);
}

main().catch((err) => { console.error('[fatal]', err); process.exit(1); });
