// Formats papier supportés par imprimante (largeur × hauteur en mm).
// « 80mm » = rouleau thermique 80 mm (ticket réduit proportionnellement).

// `continuous: true` = rouleau thermique : la hauteur du ticket s'adapte au
// contenu (une seule page, pas de découpe au milieu). `false` = étiquette
// pré-découpée (Munbyn 100×150) : hauteur fixe imposée par l'étiquette.
// `contentScale` : facteur de mise à l'échelle du design (largeur de référence
// 100 mm) vers la largeur papier — appliqué au rendu PDF.
// `widthMm` = largeur PAPIER ; `printWidthMm` = largeur réellement IMPRIMABLE
// (zone de chauffe de la tête, souvent < papier → sinon coupe à droite). Le
// ticket est mis à l'échelle sur `printWidthMm`. Ajustable via .env ROLL_PRINT_WIDTH_MM.
//
// `escpos: true` = impression en trame ESC/POS brute (GS v 0 + coupe) au lieu du
// chemin CUPS/PDF : contrôle exact de la hauteur (aucune page fixe du driver) et
// de la coupe. `widthDots` = largeur d'impression en points (203 dpi : 576 pts =
// 72 mm imprimables sur un rouleau 80 mm). Ajustable via .env ESCPOS_WIDTH_DOTS.
const FORMATS = {
  '100x150': { widthMm: 100, printWidthMm: 100, heightMm: 150, contentScale: 1, continuous: false },
  '80mm': { widthMm: 80, printWidthMm: 72, heightMm: 120, contentScale: 0.8, continuous: true, escpos: true, widthDots: 576 },
};

function getFormat(name) {
  return FORMATS[name] || FORMATS['100x150'];
}

module.exports = { FORMATS, getFormat };
