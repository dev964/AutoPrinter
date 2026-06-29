// ─────────────────────────────────────────────────────────────────────────────
// Logique PURE portée telle quelle depuis le monorepo drop-platform, pour que
// le ticket imprimé soit STRICTEMENT identique à celui de l'app :
//   - escapeHtml            ← apps/restaurant/src/lib/strings.ts
//   - isOrderConfirmed      ← apps/restaurant/src/lib/orderVisibility.ts
//   - computeVatBreakdown   ← packages/domain-logic/src/vat.ts
//   - CANONICAL_COPEAT_VAT  ← packages/domain-logic/src/vat.ts
//   - splitMenuDisplay      ← packages/domain-types/src/menuFormula.ts
// Si l'app change ces règles, resynchroniser ce fichier.
// ─────────────────────────────────────────────────────────────────────────────

/** Échappe les caractères HTML dangereux. */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] ?? c));
}

/**
 * Règle d'affichage opérationnel : on n'imprime QUE les commandes payées au
 * comptoir, ou dont le paiement est confirmé, ou les repas personnels.
 */
function isOrderConfirmed(o) {
  if (o.isStaffMeal) return true;
  if (o.paymentStatus === 'captured') return true;
  if (o.paymentMethod === 'counter') return true;
  return false;
}

/** Taux de TVA COP'EAT par catégorie produit (basis points). */
const CANONICAL_COPEAT_VAT_BPS = {
  food_prepared_delivery: 1000,
  food_prepared_onsite: 1000,
  food_unprepared: 550,
  beverage_unsweetened: 550,
  beverage_sweetened: 2000,
  beverage_alcoholic: 2000,
};

/** Détail TVA groupé par taux — port fidèle de domain-logic/src/vat.ts. */
function computeVatBreakdown(lines, vatRates) {
  const rateByCategory = new Map(vatRates.map((r) => [r.category, r.rateBps]));

  const nonDeliveryLines = lines.filter((l) => l.vatCategory !== 'delivery_fee');

  let dominantRateBps = 1000;
  if (nonDeliveryLines.length > 0) {
    let maxBase = 0;
    for (const line of nonDeliveryLines) {
      const base = line.unitPriceCentsExclVat * line.quantity;
      if (base > maxBase) {
        maxBase = base;
        dominantRateBps = rateByCategory.get(line.vatCategory) ?? 2000;
      }
    }
  }

  const enrichedLines = lines.map((line) => {
    const rateBps =
      line.vatCategory === 'delivery_fee'
        ? dominantRateBps
        : rateByCategory.get(line.vatCategory) ?? 2000;
    const totalCentsExclVat = line.unitPriceCentsExclVat * line.quantity;
    const vatCents = Math.round((totalCentsExclVat * rateBps) / 10000);
    return { ...line, vatRateBps: rateBps, vatCents, totalCentsExclVat, totalCentsInclVat: totalCentsExclVat + vatCents };
  });

  const byRate = new Map();
  for (const line of enrichedLines) {
    const existing = byRate.get(line.vatRateBps) ?? { baseExclVatCents: 0, vatCents: 0 };
    byRate.set(line.vatRateBps, {
      baseExclVatCents: existing.baseExclVatCents + line.totalCentsExclVat,
      vatCents: existing.vatCents + line.vatCents,
    });
  }
  const vatBreakdown = Array.from(byRate.entries()).map(([rateBps, v]) => ({ rateBps, ...v }));
  const totalExclVatCents = enrichedLines.reduce((s, l) => s + l.totalCentsExclVat, 0);
  const totalVatCents = enrichedLines.reduce((s, l) => s + l.vatCents, 0);
  return { enrichedLines, vatBreakdown, totalExclVatCents, totalVatCents, totalInclVatCents: totalExclVatCents + totalVatCents };
}

/** Sépare les articles en bloc « Formule » + reste « à la carte ». */
function splitMenuDisplay(items, mf) {
  if (!mf || !mf.lines || mf.lines.length === 0) {
    return { formulaLines: [], aLaCarte: items.slice() };
  }
  const quota = new Map();
  const supplByItem = new Map();
  const unitsByItem = new Map();
  for (const l of mf.lines) {
    quota.set(l.itemId, (quota.get(l.itemId) ?? 0) + l.unitsInMenu);
    supplByItem.set(l.itemId, (supplByItem.get(l.itemId) ?? 0) + l.supplementCents);
    unitsByItem.set(l.itemId, (unitsByItem.get(l.itemId) ?? 0) + l.unitsInMenu);
  }

  const formulaLines = [];
  const aLaCarte = [];
  for (const it of items) {
    const id = it.itemId ?? '';
    const remaining = quota.get(id) ?? 0;
    let qty = it.qty;
    if (remaining > 0) {
      const take = Math.min(qty, remaining);
      quota.set(id, remaining - take);
      qty -= take;
      const tot = unitsByItem.get(id) ?? 0;
      const supplementCents = tot > 0 ? Math.round(((supplByItem.get(id) ?? 0) * take) / tot) : 0;
      formulaLines.push({
        itemId: id,
        name: it.name,
        unitsInMenu: take,
        supplementCents,
        options: (it.options ?? []).filter((o) => o.label),
        ...(it.category ? { category: it.category } : {}),
      });
    }
    if (qty > 0) aLaCarte.push({ ...it, qty });
  }
  return { formulaLines, aLaCarte };
}

module.exports = {
  escapeHtml,
  isOrderConfirmed,
  CANONICAL_COPEAT_VAT_BPS,
  computeVatBreakdown,
  splitMenuDisplay,
};
