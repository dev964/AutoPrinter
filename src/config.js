// Configuration partagée : .env, profils imprimantes, sélection active.
//
// .env — profils multiples (recommandé si deux imprimantes branchées) :
//   PRINTERS=munbyn:Munbyn:100x150,pos80:POS80:80mm
//   ACTIVE_PRINTER=munbyn
//
// Rétrocompatibilité : PRINTER_NAME=Munbyn seul → un profil « default » 100×150.

const fs = require('fs');
const path = require('path');
const { getFormat } = require('./formats');

function loadDotEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* pas de .env */ }
}

/** @returns {Map<string, { key: string, cupsName: string, format: string }>} */
function loadPrinterProfiles() {
  const profiles = new Map();
  const raw = process.env.PRINTERS;
  if (raw) {
    for (const entry of raw.split(',')) {
      const parts = entry.trim().split(':');
      if (parts.length < 2) continue;
      const [key, cupsName, format = '100x150'] = parts;
      if (!key || !cupsName) continue;
      profiles.set(key, { key, cupsName, format });
    }
  }
  if (profiles.size === 0 && process.env.PRINTER_NAME) {
    profiles.set('default', {
      key: 'default',
      cupsName: process.env.PRINTER_NAME,
      format: '100x150',
    });
  }
  return profiles;
}

/** Clé `--printer=xxx` dans argv, sinon null. */
function printerKeyFromArgv(argv = process.argv) {
  const arg = argv.find((a) => a.startsWith('--printer='));
  return arg ? arg.slice('--printer='.length).trim() : null;
}

/**
 * Résout le profil imprimante actif.
 * @param {string|null} [overrideKey]  clé explicite (--printer ou ACTIVE_PRINTER)
 */
function resolvePrinter(overrideKey = null) {
  const profiles = loadPrinterProfiles();
  if (profiles.size === 0) {
    throw new Error('Aucune imprimante configurée (PRINTERS ou PRINTER_NAME manquant).');
  }

  const candidates = [
    overrideKey,
    printerKeyFromArgv(),
    process.env.ACTIVE_PRINTER,
    profiles.has('default') ? 'default' : null,
    [...profiles.keys()][0],
  ].filter(Boolean);

  for (const key of candidates) {
    const p = profiles.get(key);
    if (p) return { ...p, pageFormat: getFormat(p.format) };
  }

  const available = [...profiles.keys()].join(', ');
  throw new Error(`Imprimante « ${candidates[0]} » introuvable. Profils disponibles : ${available}`);
}

function listPrinterProfiles() {
  return loadPrinterProfiles();
}

module.exports = {
  loadDotEnv,
  loadPrinterProfiles,
  printerKeyFromArgv,
  resolvePrinter,
  listPrinterProfiles,
};
