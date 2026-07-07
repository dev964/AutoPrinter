// ─────────────────────────────────────────────────────────────────────────────
// Génération du TICKET CLIENT 100×150 mm — port fidèle de
// apps/restaurant/src/lib/printTicketClient.ts (mise en page, TVA, formules,
// QR Instagram). Produit le HTML ; la conversion HTML→PDF→imprimante est faite
// dans print.js. Toute évolution visuelle côté app doit être répercutée ici.
// ─────────────────────────────────────────────────────────────────────────────

const QRCode = require('qrcode');
const { escapeHtml, CANONICAL_COPEAT_VAT_BPS, computeVatBreakdown, splitMenuDisplay } = require('./lib');
const { getFormat } = require('./formats');

const INSTAGRAM_URL = 'https://www.instagram.com/feels_eat?igsh=ODd5NGs0YmZxbGRj';
const INSTA_LOGO = `<svg class="ig" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="2.2" y="2.2" width="19.6" height="19.6" rx="5.4"/><circle cx="12" cy="12" r="4.4"/><circle cx="17.6" cy="6.4" r="1.15" fill="#000" stroke="none"/></svg>`;

function eur(cents) {
  return (cents / 100).toFixed(2).replace('.', ',') + ' €';
}
function unitInclVat(it) {
  return (it.unitPriceCents ?? 0) + (it.options ?? []).reduce((s, o) => s + o.priceCents, 0);
}

/** Taux TVA COP'EAT (Firestore `vatRates`), best-effort (fallback canonique). */
async function loadVatRates(db) {
  try {
    const snap = await db.collection('vatRates').get();
    const rates = snap.docs
      .map((d) => d.data())
      .filter((r) => r['entityCode'] === 'copeat' && r['effectiveTo'] == null)
      .map((r) => ({ entityCode: 'copeat', category: r['category'], rateBps: r['rateBps'] }));
    if (rates.length === 0) console.warn('[ticket] aucun taux TVA copeat actif dans vatRates');
    return rates;
  } catch (err) {
    console.warn('[ticket] vatRates load failed', err.message);
    return [];
  }
}

/** Vraie catégorie TVA par produit : itemId → vatCategory (catalogue marque). */
async function loadProductVatCategories(db, brandId) {
  const map = new Map();
  if (!brandId) return map;
  try {
    const snap = await db.collection('brands').doc(brandId).collection('items').get();
    for (const d of snap.docs) {
      const vc = d.data()['vatCategory'];
      if (vc) map.set(d.id, vc);
    }
  } catch (err) {
    console.warn('[ticket] catalogue produits illisible, TVA des lignes conservée', err.message);
  }
  return map;
}

function formatDateFr(order) {
  const raw = order.createdAt;
  const d =
    raw instanceof Date ? raw
    : typeof raw === 'string' ? new Date(raw)
    : raw && typeof raw.toDate === 'function' ? raw.toDate()
    : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/**
 * Construit le HTML du ticket client 100×150 mm pour une commande.
 * @param {FirebaseFirestore.Firestore} db  Firestore (Admin SDK)
 * @param {object} order                    Document foodOrders (avec id)
 * @param {string} dailyLabelMessage        Message du jour (kitchenOperators)
 * @param {{ format?: string }} [opts]       Format papier (100x150, 80mm)
 * @returns {Promise<string>} HTML complet imprimable
 */
async function renderTicketHtml(db, order, dailyLabelMessage = '', opts = {}) {
  const pageFmt = getFormat(opts.format);
  // Rouleau continu → hauteur libre (adaptée au contenu par print.js) ;
  // étiquette pré-découpée → hauteur fixe. Le scaling largeur est fait au PDF.
  const continuous = pageFmt.continuous === true;
  const designW = 100;
  const designH = 150;
  const items = order.items ?? [];
  const hasPrices = items.some((it) => typeof it.unitPriceCents === 'number');

  let qrSvg = '';
  try {
    qrSvg = await QRCode.toString(INSTAGRAM_URL, {
      type: 'svg', margin: 0, errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#FFFFFF' }, width: 200,
    });
  } catch (err) {
    console.warn('[ticket] QR generation failed', err.message);
  }

  // ── TVA : un total par taux présent puis le total TVA ──────────────────────
  let vatRows = '';
  if (hasPrices) {
    const byCat = new Map(Object.entries(CANONICAL_COPEAT_VAT_BPS));
    for (const r of await loadVatRates(db)) byCat.set(r.category, r.rateBps);
    const vatRates = Array.from(byCat, ([category, rateBps]) => ({ entityCode: 'copeat', category, rateBps }));

    const productVat = await loadProductVatCategories(db, order.brandId);
    const vatLines = items.map((it) => {
      const incl = unitInclVat(it);
      const vatCategory = (it.itemId && productVat.get(it.itemId)) || it.vatCategory || 'food_prepared_delivery';
      const rate = byCat.get(vatCategory) ?? 1000;
      return {
        description: it.name,
        quantity: it.qty,
        unitPriceCentsExclVat: Math.round((incl * 10000) / (10000 + rate)),
        vatCategory,
      };
    });
    const deliveryFee = order.deliveryFeeCents ?? 0;
    if (deliveryFee > 0) {
      vatLines.push({
        description: 'Frais de livraison',
        quantity: 1,
        unitPriceCentsExclVat: Math.round((deliveryFee * 10000) / (10000 + 1000)),
        vatCategory: 'delivery_fee',
      });
    }
    const vb = computeVatBreakdown(vatLines, vatRates);
    const perRate = vb.vatBreakdown
      .sort((a, b) => a.rateBps - b.rateBps)
      .map((r) => `<tr>
          <td>TVA ${(r.rateBps / 100).toFixed(r.rateBps % 100 ? 1 : 0)}%</td>
          <td class="num">${eur(r.baseExclVatCents)}</td>
          <td class="num">${eur(r.vatCents)}</td>
        </tr>`)
      .join('');
    const totalRow = `<tr class="vt">
      <td>Total TVA</td>
      <td class="num">${eur(vb.totalExclVatCents)}</td>
      <td class="num">${eur(vb.totalVatCents)}</td>
    </tr>`;
    vatRows = perRate + totalRow;
  }

  const isClickCollect = order.fulfillmentMode === 'click_collect';
  const modeLabel = isClickCollect ? 'CLICK & COLLECT' : 'LIVRAISON';
  const numLabel =
    typeof order.dailyOrderNumber === 'number'
      ? `N°${order.dailyOrderNumber}`
      : `#${order.id.slice(0, 6)}`;
  const addressLabel = order.deliveryAddress?.formatted ?? '';

  const mf = order.menuFormula ?? null;

  // ── Totaux ──────────────────────────────────────────────────────────────
  const itemsGross = items.reduce((s, it) => s + unitInclVat(it) * it.qty, 0);
  const subtotalRaw = order.subtotalCents ?? itemsGross;
  const delivery = order.deliveryFeeCents ?? 0;
  const promoLoyaltyRemise = (order.discountCents ?? 0) + (order.loyaltyRedeemCents ?? 0);
  const subtotal = mf ? subtotalRaw - mf.discountCents : subtotalRaw;
  const remise = mf ? promoLoyaltyRemise : promoLoyaltyRemise + (order.menuFormulaDiscountCents ?? 0);
  const total = order.totalEurosCents ?? subtotal + delivery - remise;
  const isCounter = order.paymentMethod === 'counter';
  const isPaid = order.paymentStatus === 'captured';
  const payLabel = isCounter
    ? (isPaid ? 'Payé au comptoir' : 'À PAYER AU COMPTOIR')
    : (isPaid ? 'Payé en ligne' : 'Paiement à confirmer');

  const { formulaLines, aLaCarte } = splitMenuDisplay(items, mf);

  const formulaHtml = mf
    ? (() => {
        const menusTotal = mf.baseTotalCents + mf.supplementsCents;
        const lines = formulaLines
          .map((l) => {
            const suppl = l.supplementCents > 0 ? ` <span class="suppl">(+${eur(l.supplementCents)} suppl.)</span>` : '';
            const q = l.unitsInMenu > 1 ? `${l.unitsInMenu}× ` : '';
            const optHtml = l.options.length
              ? `<div class="opts">${l.options.map((o) => escapeHtml(o.label)).join(' · ')}</div>`
              : '';
            return `<tr><td class="qty"></td><td class="name fline">${q}${escapeHtml(l.name)}${suppl}${optHtml}</td><td class="num"></td></tr>`;
          })
          .join('');
        const detail = `<tr><td></td><td class="fdetail" colspan="2">Menu ${eur(mf.unitPriceCents)} × ${mf.count}${
          mf.supplementsCents > 0 ? ` + supplément ${eur(mf.supplementsCents)}` : ''
        }</td></tr>`;
        return `<tr class="cat formule"><td colspan="2">Formule déjeuner ×${mf.count}</td><td class="num">${
          hasPrices ? eur(menusTotal) : ''
        }</td></tr>${lines}${detail}`;
      })()
    : '';

  const categories = ['plat', 'dessert', 'boisson', 'side', 'sauce'];
  const catLabel = (c) =>
    ({ dessert: 'Desserts', boisson: 'Boissons', side: 'Accompagnements', sauce: 'Sauces' }[c]) ?? 'Plats';
  const byCat = new Map(categories.map((c) => [c, []]));
  for (const it of aLaCarte) byCat.get(it.category ?? 'plat').push(it);
  const showCatLabels =
    !!formulaHtml || categories.filter((c) => (byCat.get(c) ?? []).length > 0).length > 1;
  const itemsHtml = formulaHtml + categories
    .map((cat) => {
      const list = byCat.get(cat) ?? [];
      if (!list.length) return '';
      const head = showCatLabels ? `<tr class="cat"><td colspan="3">${escapeHtml(catLabel(cat))}</td></tr>` : '';
      return head + list.map((it) => {
        const opts = (it.options ?? []).filter((o) => o.label);
        const optHtml = opts.length
          ? `<div class="opts">${opts.map((o) => escapeHtml(o.label) + (o.priceCents ? ` (+${eur(o.priceCents)})` : '')).join(' · ')}</div>`
          : '';
        return `<tr>
          <td class="qty">${it.qty}×</td>
          <td class="name">${escapeHtml(it.name)}${optHtml}</td>
          <td class="num">${hasPrices ? eur(unitInclVat(it) * it.qty) : ''}</td>
        </tr>`;
      }).join('');
    })
    .join('');

  const summaryHtml = hasPrices
    ? `<div class="summary">
        <table class="totals">
          <tr><td>Sous-total</td><td class="num">${eur(subtotal)}</td></tr>
          ${remise > 0 ? `<tr><td>Remise</td><td class="num">- ${eur(remise)}</td></tr>` : ''}
          ${delivery > 0 ? `<tr><td>Livraison</td><td class="num">${eur(delivery)}</td></tr>` : ''}
          <tr class="grand"><td>TOTAL TTC</td><td class="num">${eur(total)}</td></tr>
        </table>
        ${vatRows ? `<table class="vat"><tr class="vh"><td>Taux</td><td class="num">Base HT</td><td class="num">TVA</td></tr>${vatRows}</table>` : ''}
        <div class="pay ${isCounter && !isPaid ? 'due' : ''}">${escapeHtml(payLabel)}</div>
      </div>`
    : '';

  const message = dailyLabelMessage.trim();
  const printedAt = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  // Échelle typographique globale : agrandit toutes les polices en conservant
  // leurs proportions (chaque taille est multipliée par le même facteur).
  // Réglable via .env `TICKET_FONT_SCALE` (1 = taille d'origine).
  const FONT_SCALE = Number(process.env.TICKET_FONT_SCALE ?? 1.15);
  const fz = (mm) => `${+(mm * FONT_SCALE).toFixed(2)}mm`;

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Ticket ${escapeHtml(order.id.slice(0, 6))}</title>
<style>
  @page { margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; color: #000; background: #fff; ${continuous ? '' : 'overflow: hidden;'} }
  .ticket {
    width: ${designW}mm; ${continuous ? '' : `height: ${designH}mm;`} padding: 3.5mm 1mm;
    display: flex; flex-direction: column;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: ${fz(2.9)}; line-height: 1.28;
  }
  .wordmark { font-family: 'Playfair Display','Times New Roman',Georgia,serif; text-align: center; font-weight: 700; font-size: ${fz(7)}; line-height: 1; padding-bottom: 1mm; border-bottom: 0.4mm solid #000; }
  .wordmark .s { font-style: italic; font-size: ${fz(4.6)}; }
  .mode { text-align: center; font-weight: 800; font-size: ${fz(2.7)}; letter-spacing: 0.3mm; border: 0.35mm solid #000; border-radius: 1mm; padding: 0.5mm 0; margin: 1.2mm 0; display: flex; align-items: center; justify-content: center; gap: 1.5mm; }
  .mode .ordernum { font-size: ${fz(6.5)}; font-weight: 800; letter-spacing: 0; }
  .client { font-size: ${fz(4)}; font-weight: 800; line-height: 1.1; word-break: break-word; }
  .meta { font-size: ${fz(2.7)}; }
  .idrow { display: flex; justify-content: space-between; font-size: ${fz(2.5)}; opacity: 0.75; margin: 0.4mm 0; }
  .divider { border-top: 0.3mm dashed #000; margin: 1.2mm 0; }
  table { width: 100%; border-collapse: collapse; }
  td { vertical-align: top; padding: 0.4mm 0; }
  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .items .qty { font-weight: 800; width: 7mm; }
  .items .name { padding-right: 1.5mm; }
  .items .cat td { font-weight: 700; font-size: ${fz(2.6)}; padding-top: 1.2mm; text-transform: uppercase; letter-spacing: 0.2mm; }
  .items .formule td { border-top: 0.3mm solid #000; padding-top: 1.2mm; }
  .items .fline { padding-left: 2.5mm; font-weight: 600; }
  .items .fline .suppl { font-weight: 400; font-size: ${fz(2.3)}; opacity: 0.8; }
  .items .fdetail { padding-left: 2.5mm; font-size: ${fz(2.4)}; font-style: italic; opacity: 0.75; padding-bottom: 0.6mm; }
  .opts { font-size: ${fz(2.3)}; opacity: 0.8; }
  .summary { margin-top: 1mm; }
  .totals { border-top: 0.3mm solid #000; padding-top: 0.8mm; }
  .totals .grand td { font-weight: 800; font-size: ${fz(3.8)}; border-top: 0.3mm solid #000; padding-top: 0.8mm; }
  .vat { margin-top: 1mm; font-size: ${fz(2.5)}; }
  .vat .vh td { font-weight: 700; border-bottom: 0.2mm solid #000; }
  .vat .vt td { font-weight: 800; border-top: 0.3mm solid #000; padding-top: 0.7mm; }
  .pay { margin-top: 1.2mm; text-align: center; font-weight: 800; font-size: ${fz(2.9)}; padding: 0.9mm; border: 0.3mm solid #000; border-radius: 1mm; }
  .pay.due { background: #000; color: #fff; }
  .footer { margin-top: ${continuous ? '2mm' : 'auto'}; display: grid; grid-template-columns: 20mm 1fr; gap: 2.5mm; padding-top: 1.5mm; border-top: 0.4mm solid #000; align-items: center; }
  .qrblock { display: flex; flex-direction: column; align-items: center; gap: 0.8mm; }
  .follow { display: flex; align-items: center; gap: 1mm; font-weight: 800; font-size: ${fz(2.4)}; white-space: nowrap; }
  .follow .ig { width: 3.4mm; height: 3.4mm; flex: none; }
  .qr { width: 18mm; height: 18mm; } .qr svg { width: 100%; height: 100%; display: block; }
  .msg { font-size: ${fz(2.9)}; font-style: italic; white-space: pre-wrap; word-break: break-word; }
</style></head>
<body>
  <div class="ticket">
  <div class="wordmark">FEEL<span class="s">&rsquo;s</span></div>
  <div class="mode"><span class="ordernum">${escapeHtml(numLabel)}</span><span>${escapeHtml(modeLabel)}</span></div>
  <div class="client">${escapeHtml(order.customerName ?? 'Client')}</div>
  ${order.customerPhone ? `<div class="meta">${escapeHtml(order.customerPhone)}</div>` : ''}
  ${addressLabel ? `<div class="meta">${escapeHtml(addressLabel)}</div>` : ''}
  <div class="idrow"><span>#${escapeHtml(order.id.slice(0, 6))}</span><span>${escapeHtml(formatDateFr(order))}</span><span>Imprimé ${escapeHtml(printedAt)}</span></div>
  <div class="divider"></div>
  <table class="items">${itemsHtml}</table>
  ${summaryHtml}
  <div class="footer">
    <div class="qrblock">
      <div class="follow">${INSTA_LOGO}<span>Suivez-nous</span></div>
      <div class="qr">${qrSvg}</div>
    </div>
    <div class="msg">${message ? escapeHtml(message) : 'Bonne dégustation !'}</div>
  </div>
  </div>
</body></html>`;
}

module.exports = { renderTicketHtml };
