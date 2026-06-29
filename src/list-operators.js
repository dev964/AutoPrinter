// Liste les cuisines (collection `kitchenOperators`) avec leur id, pour
// renseigner KITCHEN_OPERATOR_ID dans le .env.
//   node src/list-operators.js
// Nécessite seulement SERVICE_ACCOUNT_PATH (dans .env ou l'environnement).
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

// Mini-chargeur .env (identique à index.js).
try {
  const txt = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* pas de .env */ }

const KEY = process.env.SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!KEY || !fs.existsSync(KEY)) {
  console.error('SERVICE_ACCOUNT_PATH manquant ou introuvable. Renseigne-le dans .env d’abord.');
  process.exit(1);
}

(async () => {
  admin.initializeApp({ credential: admin.credential.cert(require(path.resolve(KEY))) });
  const snap = await admin.firestore().collection('kitchenOperators').get();
  if (snap.empty) { console.log('Aucune cuisine dans `kitchenOperators`.'); return; }
  console.log(`\n${snap.size} cuisine(s) — copie l’ID voulu dans KITCHEN_OPERATOR_ID :\n`);
  for (const d of snap.docs) {
    const x = d.data();
    const name = x.name || x.displayName || x.label || x.brandName || '(sans nom)';
    console.log(`  ID: ${d.id}`);
    console.log(`     nom: ${name}`);
    if (x.dailyLabelMessage) console.log(`     message du jour: "${x.dailyLabelMessage}"`);
    console.log('');
  }
  process.exit(0);
})().catch((e) => { console.error('Erreur:', e.message); process.exit(1); });
