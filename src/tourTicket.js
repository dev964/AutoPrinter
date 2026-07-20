// ─────────────────────────────────────────────────────────────────────────────
// Ticket de TOURNÉE (livraison) — rendu serveur, imprimé via le MÊME pipeline
// que les tickets commande (renderTicketHtml → sendToPrinter : ESC/POS ou PDF).
//
// AJOUT ISOLÉ : ne modifie RIEN du rendu des tickets commande (ticket.js).
// Appelé uniquement pour les jobs `printJobs.kind === 'tour'`.
//
// Même convention de mise en page que ticket.js : design de RÉFÉRENCE 100 mm
// (`.ticket { width: 100mm }`, `@page { margin: 0 }`), hauteur libre en rouleau
// continu, polices mises à l'échelle par `fz()`. Le pipeline (PDF `contentScale`
// ou ESC/POS raster vers `widthDots`) adapte à la largeur papier réelle.
//
// Le QR encode { b: batchId, t: token } — `token` = secret de la tournée dans
// `deliveryBatches/{id}/private/pickup` (créé ici s'il manque). Le livreur le
// scanne au « Récupérer la commande » (preuve de vérif de la box). Le token ne
// transite JAMAIS par le navigateur : lu/écrit côté serveur.
// ─────────────────────────────────────────────────────────────────────────────

const { randomBytes } = require('node:crypto');
const QRCode = require('qrcode');
const { escapeHtml } = require('./lib');
const { getFormat } = require('./formats');

async function getOrMintPickupToken(db, batchId) {
  const ref = db.collection('deliveryBatches').doc(batchId).collection('private').doc('pickup');
  const snap = await ref.get();
  const existing = snap.exists ? snap.data().token : undefined;
  if (existing) return existing;
  const token = randomBytes(24).toString('base64url');
  await ref.set({ token, createdAt: new Date() });
  return token;
}

function itemsCountOf(data) {
  return ((data && data.items) || []).reduce((s, it) => s + (it.qty || 0), 0);
}

/** Construit le HTML du ticket de tournée (design réf. 100 mm). */
async function renderTourTicketHtml(db, batchId, opts = {}) {
  const pageFmt = getFormat(opts.format);
  const continuous = pageFmt.continuous === true;
  const designW = 100;
  const designH = 150;
  const FONT_SCALE = Number(process.env.TICKET_FONT_SCALE ?? 1.15);
  const fz = (mm) => `${+(mm * FONT_SCALE).toFixed(2)}mm`;

  const batchSnap = await db.collection('deliveryBatches').doc(batchId).get();
  if (!batchSnap.exists) throw new Error(`Tournée introuvable : ${batchId}`);
  const batch = batchSnap.data();

  const tourLabel = batch.dailyBatchNumber != null
    ? `Tournée ${batch.dailyBatchNumber}`
    : `Tournée #${batchId.slice(0, 6)}`;
  const orderIds = batch.orderIds || [];
  const plannedRoute = (batch.plannedRoute || []).slice().sort((a, b) => (a.dropIdx || 0) - (b.dropIdx || 0));

  const orderSnaps = await Promise.all(
    orderIds.map((id) => db.collection('foodOrders').doc(id).get().catch(() => null)),
  );
  const byId = new Map();
  let platsTotal = 0;
  for (let i = 0; i < orderIds.length; i++) {
    const s = orderSnaps[i];
    const d = s && s.exists ? s.data() : null;
    const plats = itemsCountOf(d);
    platsTotal += plats;
    byId.set(orderIds[i], {
      name: ((d && d.customerName) || '').trim(),
      brand: ((d && d.restaurantName) || '').trim(),
      plats,
    });
  }

  const token = await getOrMintPickupToken(db, batchId);
  let qrSvg = '';
  try {
    qrSvg = await QRCode.toString(JSON.stringify({ b: batchId, t: token }), {
      type: 'svg', margin: 0, errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#FFFFFF' }, width: 240,
    });
  } catch (err) {
    console.warn('[tourTicket] QR non généré :', err.message);
  }

  const stopsHtml = plannedRoute.map((stop) => {
    const sOrderIds = stop.orderIds || [];
    const orders = sOrderIds.map((oid, idx) => {
      const info = byId.get(oid) || {};
      const name = (((stop.customerNames && stop.customerNames[idx]) || info.name || '').trim()) || 'Client';
      const brand = ((stop.brandNames && stop.brandNames[idx]) || info.brand || '').trim();
      const plats = info.plats || 0;
      const platsTxt = plats > 0 ? `${plats} plat${plats > 1 ? 's' : ''}` : '';
      const brandTxt = brand ? ` · ${escapeHtml(brand)}` : '';
      return `<div class="ord"><span class="cust">${escapeHtml(name)}</span><span class="ord-meta">${escapeHtml(platsTxt)}${brandTxt}</span></div>`;
    }).join('');
    const nb = sOrderIds.length;
    return `<div class="stop">
      <div class="stop-head"><span class="stop-idx">${(stop.dropIdx || 0) + 1}</span><span class="stop-addr">${escapeHtml(stop.formatted || '—')}</span></div>
      <div class="stop-count">${nb} commande${nb > 1 ? 's' : ''}</div>
      ${orders}
    </div>`;
  }).join('');

  const nbCommandes = orderIds.length;
  const nbArrets = plannedRoute.length;
  const platsLabel = batch.totalItemsCount != null ? batch.totalItemsCount : platsTotal;
  const kitchen = (batch.pickupAddress && batch.pickupAddress.formatted) || '';
  const driverName = (batch.driverName || '').trim();
  const qrBlock = qrSvg
    ? `<div class="qr">${qrSvg}</div><div class="qr-cap">Scannez pour récupérer</div>`
    : '';

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(tourLabel)}</title>
<style>
  @page { margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; color: #000; background: #fff; ${continuous ? '' : 'overflow: hidden;'} }
  .ticket {
    width: ${designW}mm; ${continuous ? '' : `height: ${designH}mm;`} padding: 3.5mm 3mm;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: ${fz(2.9)}; line-height: 1.3;
  }
  .top { display: flex; gap: 3mm; align-items: flex-start; border-bottom: 0.5mm solid #000; padding-bottom: 2mm; }
  .top .info { flex: 1; min-width: 0; }
  .kind { font-size: ${fz(2.6)}; font-weight: 800; letter-spacing: 0.3mm; text-transform: uppercase; opacity: 0.7; }
  .tour-name { font-family: 'Playfair Display','Times New Roman',Georgia,serif; font-weight: 800; font-size: ${fz(10)}; line-height: 1; margin-top: 0.5mm; word-break: break-word; }
  .driver { font-size: ${fz(3)}; font-weight: 700; margin-top: 1mm; }
  .kitchen { font-size: ${fz(2.5)}; opacity: 0.8; margin-top: 0.6mm; }
  .qrcol { width: 26mm; flex: none; text-align: center; }
  .qr { width: 26mm; height: 26mm; } .qr svg { width: 100%; height: 100%; display: block; }
  .qr-cap { font-size: ${fz(2.2)}; font-weight: 700; margin-top: 0.6mm; }
  .counts { display: flex; gap: 2mm; justify-content: center; font-weight: 800; font-size: ${fz(3.4)}; margin: 2mm 0; padding: 1.2mm; border: 0.35mm solid #000; border-radius: 1mm; }
  .stop { border-top: 0.3mm dashed #000; padding: 1.5mm 0; }
  .stop-head { display: flex; align-items: baseline; gap: 1.5mm; }
  .stop-idx { flex: none; width: 5.5mm; height: 5.5mm; border-radius: 50%; background: #000; color: #fff; font-weight: 800; font-size: ${fz(2.9)}; display: inline-flex; align-items: center; justify-content: center; }
  .stop-addr { font-weight: 800; font-size: ${fz(3)}; word-break: break-word; }
  .stop-count { font-size: ${fz(2.3)}; opacity: 0.7; margin: 0.4mm 0 0.6mm 7mm; }
  .ord { display: flex; justify-content: space-between; gap: 2mm; padding: 0.4mm 0 0.4mm 7mm; }
  .cust { font-weight: 700; word-break: break-word; }
  .ord-meta { font-size: ${fz(2.5)}; opacity: 0.8; white-space: nowrap; }
  .warn { margin-top: 2.5mm; border: 0.4mm solid #000; border-radius: 1mm; padding: 1.5mm; font-size: ${fz(2.6)}; font-weight: 700; }
  .warn b { text-transform: uppercase; }
</style></head>
<body><div class="ticket">
  <div class="top">
    <div class="info">
      <div class="kind">Ticket de tournée</div>
      <div class="tour-name">${escapeHtml(tourLabel)}</div>
      ${driverName ? `<div class="driver">Livreur : ${escapeHtml(driverName)}</div>` : ''}
      ${kitchen ? `<div class="kitchen">${escapeHtml(kitchen)}</div>` : ''}
    </div>
    <div class="qrcol">${qrBlock}</div>
  </div>
  <div class="counts"><span>${nbCommandes} cmd</span><span>·</span><span>${nbArrets} arrêt${nbArrets > 1 ? 's' : ''}</span><span>·</span><span>${platsLabel} plats</span></div>
  <div class="stops">${stopsHtml}</div>
  <div class="warn">⚠️ Une <b>commande</b> peut être répartie en <b>plusieurs sacs</b>. Vérifiez chaque <b>commande</b> ci-dessus — pas le nombre de sacs.</div>
</div></body></html>`;
}

module.exports = { renderTourTicketHtml };
