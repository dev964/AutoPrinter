// ─────────────────────────────────────────────────────────────────────────────
// Service d'auto-impression cuisine FEEL's — SEULE autorité d'impression.
//
// Le site (app restaurant) n'imprime plus lui-même : il écrit des signaux dans
// Firestore, ce script écoute et imprime sur la Munbyn via CUPS.
//
//   • foodOrders            → auto-impression des NOUVELLES commandes confirmées,
//                             UNIQUEMENT si le flag partagé est ON (cf. printSettings).
//   • printSettings/{id}    → flag `autoPrintEnabled` partagé (le site l'écrit,
//                             ce script le LIT seulement). Défaut : false.
//   • printJobs/{autoId}    → demande d'impression d'un ticket précis (boutons
//                             « Étiquette » du site). Ce script fait avancer le
//                             statut pending → printing → printed/failed.
//
// Réplique fidèlement, pour l'auto-impression foodOrders :
//   - la requête de KitchenBoardPage (kitchenOperatorId + statut + createdAt) ;
//   - le filtre isOrderConfirmed (paiement confirmé / comptoir / repas perso) ;
//   - l'anti-rafale (au démarrage, on mémorise l'existant SANS imprimer ; seules
//     les commandes qui ARRIVENT ensuite s'impriment), une seule fois par commande.
//     `seen` est marqué MÊME quand le flag est OFF → pas de rafale au rallumage.
//   - l'attente du numéro de commande (dailyOrderNumber posé de façon asynchrone
//     par le trigger assignFoodOrderNumber), avec repli borné.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const admin = require('firebase-admin');
const { loadDotEnv, resolvePrinter } = require('./config');
const { isOrderConfirmed } = require('./lib');
const { renderTicketHtml } = require('./ticket');
const { printHtml, closeBrowser } = require('./print');
const { printEscpos } = require('./escpos');

// Charge le .env AVANT de lire la config ci-dessous.
loadDotEnv();

// ── Config (variables d'environnement / .env) ───────────────────────────────
const SERVICE_ACCOUNT_PATH =
  process.env.SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS;
const KITCHEN_OPERATOR_ID = process.env.KITCHEN_OPERATOR_ID;
const PRINT_DELAY_MS = Number(process.env.PRINT_DELAY_MS ?? 1200);

// Profil imprimante actif (nom file CUPS + format papier), résolu au démarrage
// via config.js (PRINTERS/ACTIVE_PRINTER, repli PRINTER_NAME). Partagé auto+manuel.
let activePrinter = null;

// Force le mode d'impression : 'escpos' | 'pdf'. Par défaut, on suit le format
// (rouleau thermique → ESC/POS, étiquette pré-découpée → CUPS/PDF).
const PRINT_MODE = (process.env.PRINT_MODE || '').trim().toLowerCase();

/**
 * Envoie un ticket déjà rendu (HTML) à l'imprimante active, via ESC/POS (trame
 * brute, hauteur/coupe exactes) ou CUPS/PDF selon le format / PRINT_MODE.
 * @returns {Promise<string>} identifiant du job CUPS.
 */
function sendToPrinter(html, basename) {
  const fmt = activePrinter.pageFormat || {};
  const useEscpos = PRINT_MODE === 'escpos' || (PRINT_MODE !== 'pdf' && fmt.escpos === true);
  if (useEscpos) {
    return printEscpos(html, {
      printerName: activePrinter.cupsName,
      widthDots: fmt.widthDots,
      basename,
    });
  }
  return printHtml(html, {
    printerName: activePrinter.cupsName,
    format: activePrinter.format,
    basename,
  });
}

// Attente max du `dailyOrderNumber` avant impression avec repli #ref (ms).
const NUMBER_WAIT_MS = Number(process.env.NUMBER_WAIT_MS ?? 8000);
// Un `printJob` pending plus vieux que ça au démarrage est jugé obsolète.
const STALE_JOB_MS = Number(process.env.STALE_JOB_MS ?? 5 * 60 * 1000);

// Statuts « commande active » — strictement ceux de l'écran cuisine/envoi.
const ACTIVE_STATUSES = ['pending', 'accepted', 'preparing', 'ready_for_assembly'];

// ── File d'impression sérialisée (une impression à la fois, auto + manuel) ───
// Chaque tâche : { order, onDone?: (err|null, jobId?) => void }
const printQueue = [];
let draining = false;
async function drainQueue(db, getDailyMessage) {
  if (draining) return;
  draining = true;
  try {
    while (printQueue.length) {
      const task = printQueue.shift();
      const { order } = task;
      try {
        const html = await renderTicketHtml(db, order, getDailyMessage(), { format: activePrinter.format });
        const jobId = await sendToPrinter(html, order.id.slice(0, 6));
        console.log(`[print] ✅ ${labelOf(order)} → ${jobId}`);
        task.onDone?.(null, jobId);
      } catch (err) {
        console.error(`[print] ❌ ${labelOf(order)} :`, err.message);
        task.onDone?.(err);
      }
      if (printQueue.length) await sleep(PRINT_DELAY_MS);
    }
  } finally {
    draining = false;
  }
}

/** Pousse une commande dans la file et résout quand elle est imprimée (ou échoue). */
function enqueuePrint(db, order, getDailyMessage) {
  return new Promise((resolve) => {
    printQueue.push({ order, onDone: (err, jobId) => resolve({ err, jobId }) });
    void drainQueue(db, getDailyMessage);
  });
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

/**
 * Lit une commande à frais et attend (borné) que `dailyOrderNumber` soit posé.
 * Utilisé pour l'impression manuelle : le clic vient d'une carte déjà affichée,
 * le numéro est en général présent, mais on gère la course résiduelle.
 * @returns {Promise<object|null>} la commande, ou null si introuvable.
 */
async function fetchOrderWaitingNumber(db, orderId) {
  const ref = db.collection('foodOrders').doc(orderId);
  const deadline = Date.now() + NUMBER_WAIT_MS;
  for (;;) {
    const snap = await ref.get();
    if (!snap.exists) return null;
    const order = { id: snap.id, ...snap.data() };
    if (typeof order.dailyOrderNumber === 'number' || Date.now() >= deadline) return order;
    await sleep(1000);
  }
}

// ── Perte de connexion Firestore : on relance le process ─────────────────────
// Un listener onSnapshot qui meurt (réseau pas prêt au boot, coupure prolongée)
// ne se rétablit PAS tout seul : le SDK reste coincé sur « Exceeded retries ».
// Plutôt que de rester vivant en panne silencieuse (aucun ticket, aucun crash),
// on sort en erreur → `restart: unless-stopped` relance une instance saine
// (Docker temporise en cas de coupure réelle, donc pas de boucle serrée).
function onListenerLost(where) {
  return (err) => {
    console.error(`[${where}] connexion Firestore perdue : ${err.message} — redémarrage.`);
    process.exit(1);
  };
}

// ── Démarrage ────────────────────────────────────────────────────────────────
async function main() {
  if (process.argv.includes('--test-print')) return testPrint();

  if (process.argv.includes('--check-config')) {
    console.log('SERVICE_ACCOUNT_PATH =', SERVICE_ACCOUNT_PATH || '(manquant)');
    console.log('KITCHEN_OPERATOR_ID  =', KITCHEN_OPERATOR_ID || '(manquant)');
    try {
      const p = resolvePrinter();
      console.log('imprimante active    =', `${p.key} → ${p.cupsName} (${p.format})`);
    } catch (e) {
      console.log('imprimante active    = (aucune) —', e.message);
    }
    console.log('clé lisible ?        =', SERVICE_ACCOUNT_PATH ? fs.existsSync(SERVICE_ACCOUNT_PATH) : false);
    return;
  }

  if (!SERVICE_ACCOUNT_PATH) fail('SERVICE_ACCOUNT_PATH manquant (clé service account JSON).');
  if (!KITCHEN_OPERATOR_ID) fail('KITCHEN_OPERATOR_ID manquant (id de la cuisine à écouter).');
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) fail(`Clé introuvable : ${SERVICE_ACCOUNT_PATH}`);

  try {
    activePrinter = resolvePrinter();
  } catch (e) {
    fail(e.message); // aucune imprimante configurée (PRINTERS ou PRINTER_NAME)
  }

  const serviceAccount = require(require('path').resolve(SERVICE_ACCOUNT_PATH));
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  console.log(`[init] projet=${serviceAccount.project_id} opérateur=${KITCHEN_OPERATOR_ID} imprimante=${activePrinter.cupsName} (${activePrinter.format})`);

  // Message du jour (kitchenOperators/{id}.dailyLabelMessage), tenu à jour.
  let dailyLabelMessage = '';
  db.collection('kitchenOperators').doc(KITCHEN_OPERATOR_ID).onSnapshot(
    (snap) => { dailyLabelMessage = snap.data()?.dailyLabelMessage ?? ''; },
    (err) => console.warn('[init] message du jour indisponible :', err.message),
  );

  // ── Flag d'auto-impression partagé (printSettings), le site l'écrit ────────
  let autoPrintEnabled = false;
  db.collection('printSettings').doc(KITCHEN_OPERATOR_ID).onSnapshot(
    (snap) => {
      const next = snap.exists && snap.data()?.autoPrintEnabled === true;
      if (next !== autoPrintEnabled) console.log(`[flag] auto-impression → ${next ? 'ON' : 'OFF'}`);
      autoPrintEnabled = next;
    },
    onListenerLost('flag'),
  );

  // ── Repli borné pour l'attente du numéro (auto-impression) ─────────────────
  // Les snapshots ne se redéclenchent que sur changement : si le trigger
  // assignFoodOrderNumber n'arrive jamais, ce setTimeout force l'impression avec
  // #ref (un ticket sans numéro reste préférable à pas de ticket).
  const fallbackTimers = new Map();
  const armFallback = (order) => {
    if (fallbackTimers.has(order.id)) return; // déjà armé
    const t = setTimeout(() => {
      fallbackTimers.delete(order.id);
      if (seen.has(order.id)) return;
      seen.add(order.id);
      console.log(`[watch] ⏱️ ${labelOf(order)} → numéro toujours absent, repli #ref`);
      if (autoPrintEnabled) {
        printQueue.push({ order });
        void drainQueue(db, () => dailyLabelMessage);
      }
    }, NUMBER_WAIT_MS);
    fallbackTimers.set(order.id, t);
  };
  const clearFallback = (id) => {
    const t = fallbackTimers.get(id);
    if (t) { clearTimeout(t); fallbackTimers.delete(id); }
  };

  // ── Watcher foodOrders : auto-impression gated + attente du numéro ─────────
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
        if (isTestOrder(o)) { seen.add(o.id); continue; } // test : jamais imprimé, marqué vu
        // Paiement pas encore confirmé (ex. livraison en ligne : authorizing → captured) :
        // on NE marque PAS `seen` → on réévaluera au snapshot où il passe captured.
        if (!isOrderConfirmed(o)) continue;

        // Numéro pas encore posé par assignFoodOrderNumber → on attend le snapshot
        // où le trigger le pose (NE PAS marquer seen), avec repli borné.
        if (typeof o.dailyOrderNumber !== 'number') { armFallback(o); continue; }

        clearFallback(o.id);
        seen.add(o.id); // vu au moment de la décision → une seule fois, flag ON ou OFF
        if (autoPrintEnabled) {
          console.log(`[watch] 🆕 ${labelOf(o)} → impression auto`);
          printQueue.push({ order: o });
          void drainQueue(db, () => dailyLabelMessage);
        } else {
          console.log(`[watch] 🔕 ${labelOf(o)} vue (auto OFF) — pas d'impression`);
        }
      }
    },
    onListenerLost('watch'),
  );

  // ── Watcher printJobs : impression manuelle d'un ticket précis ─────────────
  const jobsInFlight = new Set(); // anti-doublon intra-process
  db.collection('printJobs')
    .where('kitchenOperatorId', '==', KITCHEN_OPERATOR_ID)
    .where('status', '==', 'pending')
    .onSnapshot(
      (snap) => {
        for (const change of snap.docChanges()) {
          if (change.type === 'removed') continue; // sorti de la requête (déjà réclamé)
          void handlePrintJob(db, change.doc, jobsInFlight, () => dailyLabelMessage);
        }
      },
      onListenerLost('jobs'),
    );

  console.log('[watch] en écoute : commandes + flag + demandes manuelles… (Ctrl+C pour arrêter)');

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      console.log(`\n[exit] ${sig} — fermeture.`);
      await closeBrowser();
      process.exit(0);
    });
  }
}

/**
 * Traite une demande d'impression manuelle (printJobs).
 * Réclame le job de façon atomique (pending → printing), imprime via la file
 * sérialisée partagée, puis marque printed/failed.
 */
async function handlePrintJob(db, docSnap, jobsInFlight, getDailyMessage) {
  const id = docSnap.id;
  if (jobsInFlight.has(id)) return;
  jobsInFlight.add(id);
  const ref = docSnap.ref;
  const FieldValue = admin.firestore.FieldValue;
  try {
    const data = docSnap.data();
    const requestedAtMs = data.requestedAt?.toMillis?.() ?? null;
    const stale = requestedAtMs != null && (Date.now() - requestedAtMs) > STALE_JOB_MS;

    // Réclamer le job de façon atomique : anti-doublon si double-clic, snapshots
    // répétés, ou redémarrage. Garde-fou d'ancienneté : purge les vieux pending.
    const claim = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(ref);
      if (!fresh.exists || fresh.data().status !== 'pending') return 'skip';
      if (stale) {
        tx.update(ref, { status: 'failed', error: 'obsolète au redémarrage' });
        return 'stale';
      }
      tx.update(ref, { status: 'printing' });
      return 'claimed';
    });
    if (claim === 'stale') { console.log(`[job] ⏭️ ${id} obsolète → failed`); return; }
    if (claim !== 'claimed') return; // déjà pris par un autre snapshot/instance

    const order = await fetchOrderWaitingNumber(db, data.orderId);
    if (!order) {
      await ref.update({ status: 'failed', error: `commande ${data.orderId} introuvable` });
      console.error(`[job] ❌ ${id} : commande ${data.orderId} introuvable`);
      return;
    }

    console.log(`[job] 🖨️ ${id} (${data.source ?? '?'}) → ${labelOf(order)}`);
    const { err, jobId } = await enqueuePrint(db, order, getDailyMessage);
    if (err) {
      await ref.update({ status: 'failed', error: err.message });
    } else {
      await ref.update({ status: 'printed', printedAt: FieldValue.serverTimestamp() });
      console.log(`[job] ✅ ${id} → ${jobId}`);
    }
  } catch (e) {
    await ref.update({ status: 'failed', error: e.message }).catch(() => {});
    console.error(`[job] ❌ ${docSnap.id} :`, e.message);
  } finally {
    jobsInFlight.delete(id);
  }
}

// ── Mode test imprimante (sans Firebase) : imprime un faux ticket ───────────
async function testPrint() {
  try {
    activePrinter = resolvePrinter();
  } catch (e) {
    fail(e.message);
  }
  console.log(`[test] génération d’un ticket de démonstration… (${activePrinter.cupsName}, ${activePrinter.format})`);
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
  const html = await renderTicketHtml(stubDb, fakeOrder, 'Merci et à bientôt chez FEEL’s !', { format: activePrinter.format });
  const job = await sendToPrinter(html, 'test');
  console.log(`[test] envoyé à « ${activePrinter.cupsName} » → ${job}`);
  await closeBrowser();
}

function fail(msg) {
  console.error(`[config] ${msg}`);
  process.exit(1);
}

main().catch((err) => { console.error('[fatal]', err); process.exit(1); });
