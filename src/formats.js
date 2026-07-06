// Formats papier supportés par imprimante (largeur × hauteur en mm).
// « 80mm » = rouleau thermique 80 mm (ticket réduit proportionnellement).

const FORMATS = {
  '100x150': { widthMm: 100, heightMm: 150, contentScale: 1 },
  '80mm': { widthMm: 80, heightMm: 120, contentScale: 0.8 },
};

function getFormat(name) {
  return FORMATS[name] || FORMATS['100x150'];
}

module.exports = { FORMATS, getFormat };
