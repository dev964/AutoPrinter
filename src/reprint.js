// ─────────────────────────────────────────────────────────────────────────────
// Réimpression manuelle (rattrapage des commandes non imprimées).
//
// PRUDENT PAR DÉFAUT : sans argument, liste les candidats et n'imprime RIEN.
//
//   node src/reprint.js                          # aperçu (n'imprime rien)
//   node src/reprint.js --all-modes              # inclut aussi le comptoir (déjà imprimé)
//   node src/reprint.js --print --all            # imprime TOUS les candidats listés
//   node src/reprint.js --print --ids=abc123,def # imprime seulement ces commandes
//   node src/reprint.js --dry --all              # génère les PDF sans imprimer (aperçu)
//
// Candidats par défaut = commandes ACTIVES, confirmées, payées EN LIGNE
// (paymentMethod ≠ counter) — c.-à-d. les victimes du bug. Le comptoir sortait déjà.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { loadDotEnv, resolvePrinter } = require('./config');
const { isOrderConfirmed } = require('./lib');
const { renderTicketHtml } = require('./ticket');
const { printHtml, htmlToPdf, closeBrowser } = require('./print');

loadDotEnv();
const SERVICE_ACCOUNT_PATH =
  process.env.SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS;
const KITCHEN_OPERATOR_ID = process.env.KITCHEN_OPERATOR_ID;
const ACTIVE_STATUSES = ['pending', 'accepted', 'preparing', 'ready_for_assembly'];

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const idsArg = (args.find((a) => a.startsWith('--ids=')) || '').replace('--ids=', '');
const wantedIds = idsArg
  ? new Set(idsArg.split(',').map((s) => s.trim()).filter(Boolean))
  : null;
const doPrint = has('--print');
const dry = has('--dry');
const allModes = has('--all-modes');

const labelOf = (o) => {
  const num = typeof o.dailyOrderNumber === 'number' ? `N°${o.dailyOrderNumber}` : `#${o.id.slice(0, 6)}`;
  return `${num} ${o.customerName ?? 'Client'}`;
};
const isTestOrder = (o) =>
  o.isTestOrder === true || (o.customerName ?? '').trim().toLowerCase() === 'test';

(async () => {
  if (!SERVICE_ACCOUNT_PATH || !fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    console.error('Clé service account introuvable :', SERVICE_ACCOUNT_PATH || '(manquant)');
    process.exit(1);
  }
  if (!KITCHEN_OPERATOR_ID) { console.error('KITCHEN_OPERATOR_ID manquant.'); process.exit(1); }

  let printer;
  try {
    printer = resolvePrinter();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  console.log(`Imprimante : ${printer.key} → ${printer.cupsName} (${printer.format})\n`);

  const sa = require(path.resolve(SERVICE_ACCOUNT_PATH));
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore();

  let dailyLabelMessage = '';
  try {
    const s = await db.collection('kitchenOperators').doc(KITCHEN_OPERATOR_ID).get();
    dailyLabelMessage = s.data()?.dailyLabelMessage ?? '';
  } catch { /* message du jour indisponible : on continue sans */ }

  const snap = await db.collection('foodOrders')
    .where('kitchenOperatorId', '==', KITCHEN_OPERATOR_ID)
    .where('status', 'in', ACTIVE_STATUSES)
    .orderBy('createdAt', 'asc')
    .get();

  let orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((o) => !isTestOrder(o))
    .filter((o) => isOrderConfirmed(o));
  if (!allModes) orders = orders.filter((o) => o.paymentMethod !== 'counter');
  if (wantedIds) orders = orders.filter((o) => wantedIds.has(o.id) || wantedIds.has(o.id.slice(0, 6)));

  if (orders.length === 0) {
    console.log('Aucune commande candidate (active + confirmée' + (allModes ? '' : ' + payée en ligne') + ').');
    await closeBrowser().catch(() => {});
    process.exit(0);
  }

  console.log(`\n${orders.length} commande(s) candidate(s)${allModes ? '' : ' — paiement en ligne ; --all-modes pour inclure le comptoir'} :`);
  console.log('  id      mode           statut        paiement    client');
  for (const o of orders) {
    console.log(`  ${o.id.slice(0, 6)}  ${String(o.fulfillmentMode ?? '').padEnd(13)}  ${String(o.status ?? '').padEnd(12)}  ${String(o.paymentStatus ?? '').padEnd(10)}  ${labelOf(o)}`);
  }

  if (!doPrint && !dry) {
    console.log('\nAperçu uniquement — rien n\'a été imprimé.');
    console.log('  Imprimer tout :  node src/reprint.js --print --all');
    console.log('  Sélection     :  node src/reprint.js --print --ids=abc123,def456');
    await closeBrowser().catch(() => {});
    process.exit(0);
  }

  if (doPrint && !wantedIds && !has('--all')) {
    console.error('\nSécurité : avec --print, précise --all ou --ids=… (pour éviter une impression involontaire).');
    await closeBrowser().catch(() => {});
    process.exit(1);
  }

  for (const o of orders) {
    try {
      const html = await renderTicketHtml(db, o, dailyLabelMessage, { format: printer.format });
      if (dry) {
        const { path: pdf } = await htmlToPdf(html, o.id.slice(0, 6), printer.format);
        const out = path.join(__dirname, '..', `reprint-${o.id.slice(0, 6)}.pdf`);
        fs.copyFileSync(pdf, out);
        fs.unlinkSync(pdf);
        console.log(`[dry] ${labelOf(o)} → ${out}`);
      } else {
        const job = await printHtml(html, { printerName: printer.cupsName, format: printer.format, basename: o.id.slice(0, 6) });
        console.log(`[reprint] ✅ ${labelOf(o)} → ${job}`);
      }
    } catch (e) {
      console.error(`[reprint] ❌ ${labelOf(o)} :`, e.message);
    }
  }
  await closeBrowser().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error('[fatal]', e); process.exit(1); });
