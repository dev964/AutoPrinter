// ─────────────────────────────────────────────────────────────────────────────
// Service d'auto-impression cuisine FEEL's.
//
// Écoute Firestore (collection `foodOrders`) comme le fait l'écran cuisine de
// l'app, et imprime le ticket client identique dès qu'une NOUVELLE commande
// confirmée arrive — sur l'imprimante Munbyn via CUPS.
//
// Réplique fidèlement :
//   - la requête de KitchenBoardPage (kitchenOperatorId + statut + createdAt) ;
//   - le filtre isOrderConfirmed (paiement confirmé / comptoir / repas perso) ;
//   - l'anti-rafale de ProductionScreenPage (au démarrage, on mémorise
//     l'existant SANS imprimer ; seules les commandes qui ARRIVENT ensuite
//     s'impriment), une seule fois par commande.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const admin = require('firebase-admin');
const { isOrderConfirmed } = require('./lib');
const { renderTicketHtml } = require('./ticket');
const { printHtml, closeBrowser } = require('./print');

// Charge le .env AVANT de lire la config ci-dessous (les const sont évaluées au
// chargement du module ; loadDotEnv est hissée car déclarée en `function`).
loadDotEnv();

// ── Config (variables d'environnement / .env) ───────────────────────────────
const SERVICE_ACCOUNT_PATH =
  process.env.SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS;
const KITCHEN_OPERATOR_ID = process.env.KITCHEN_OPERATOR_ID;
const PRINTER_NAME = process.env.PRINTER_NAME || 'Munbyn';
const PRINT_DELAY_MS = Number(process.env.PRINT_DELAY_MS ?? 1200);

// Statuts « commande active » — strictement ceux de l'écran cuisine/envoi.
const ACTIVE_STATUSES = ['pending', 'accepted', 'preparing', 'ready_for_assembly'];

// Charge un .env minimal (KEY=VALUE) sans dépendance externe.
function loadDotEnv() {
  try {
    const txt = fs.readFileSync(require('path').join(__dirname, '..', '.env'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* pas de .env : on se fie à l'environnement */ }
}

// ── File d'impression sérialisée (une impression à la fois) ──────────────────
const printQueue = [];
let draining = false;
async function drainQueue(db, getDailyMessage) {
  if (draining) return;
  draining = true;
  try {
    while (printQueue.length) {
      const order = printQueue.shift();
      try {
        const html = await renderTicketHtml(db, order, getDailyMessage());
        const jobId = await printHtml(html, {
          printerName: PRINTER_NAME,
          basename: order.id.slice(0, 6),
        });
        console.log(`[print] ✅ ${labelOf(order)} → ${jobId}`);
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

/** Commande de test (bouton dispatch) : jamais imprimée. */
function isTestOrder(o) {
  if (o.isTestOrder) return true;
  return (o.customerName ?? '').trim().toLowerCase() === 'test';
}

// ── Démarrage ────────────────────────────────────────────────────────────────
async function main() {
  if (process.argv.includes('--test-print')) return testPrint();

  if (process.argv.includes('--check-config')) {
    console.log('SERVICE_ACCOUNT_PATH =', SERVICE_ACCOUNT_PATH || '(manquant)');
    console.log('KITCHEN_OPERATOR_ID  =', KITCHEN_OPERATOR_ID || '(manquant)');
    console.log('PRINTER_NAME         =', PRINTER_NAME);
    console.log('clé lisible ?        =', SERVICE_ACCOUNT_PATH ? fs.existsSync(SERVICE_ACCOUNT_PATH) : false);
    return;
  }

  if (!SERVICE_ACCOUNT_PATH) fail('SERVICE_ACCOUNT_PATH manquant (clé service account JSON).');
  if (!KITCHEN_OPERATOR_ID) fail('KITCHEN_OPERATOR_ID manquant (id de la cuisine à écouter).');
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) fail(`Clé introuvable : ${SERVICE_ACCOUNT_PATH}`);

  const serviceAccount = require(require('path').resolve(SERVICE_ACCOUNT_PATH));
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  console.log(`[init] projet=${serviceAccount.project_id} opérateur=${KITCHEN_OPERATOR_ID} imprimante=${PRINTER_NAME}`);

  // Message du jour (kitchenOperators/{id}.dailyLabelMessage), tenu à jour.
  let dailyLabelMessage = '';
  db.collection('kitchenOperators').doc(KITCHEN_OPERATOR_ID).onSnapshot(
    (snap) => { dailyLabelMessage = snap.data()?.dailyLabelMessage ?? ''; },
    (err) => console.warn('[init] message du jour indisponible :', err.message),
  );

  // Requête identique à KitchenBoardPage (index composite déjà présent en prod).
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
        // 1er passage : on mémorise l'existant SANS imprimer (pas de rafale).
        for (const o of orders) seen.add(o.id);
        seeded = true;
        console.log(`[watch] amorçage : ${orders.length} commande(s) active(s) ignorée(s) (déjà là).`);
        return;
      }

      for (const o of orders) {
        if (seen.has(o.id)) continue;
        seen.add(o.id); // marqué vu même si on n'imprime pas → pas de doublon
        if (isTestOrder(o)) continue;
        if (!isOrderConfirmed(o)) continue; // paiement non confirmé → ignoré
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

// ── Mode test imprimante (sans Firebase) : imprime un faux ticket ───────────
async function testPrint() {
  console.log('[test] génération d’un ticket de démonstration…');
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
  // Stub Firestore : provoque le fallback canonique (pas de vatRates/catalogue).
  const stubDb = { collection: () => ({ get: async () => ({ docs: [] }), doc: () => ({ collection: () => ({ get: async () => ({ docs: [] }) }) }) }) };
  const html = await renderTicketHtml(stubDb, fakeOrder, 'Merci et à bientôt chez FEEL’s !');
  const job = await printHtml(html, { printerName: PRINTER_NAME, basename: 'test' });
  console.log(`[test] envoyé à « ${PRINTER_NAME} » → ${job}`);
  await closeBrowser();
}

function fail(msg) {
  console.error(`[config] ${msg}`);
  process.exit(1);
}

main().catch((err) => { console.error('[fatal]', err); process.exit(1); });
