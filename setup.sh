#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Installe et configure le service d'auto-impression cuisine FEEL's sur une
# Debian/Ubuntu fraîche. Idempotent : relançable sans casse.
#
#   ./setup.sh
#
# NE PAS lancer en root (on a besoin du vrai utilisateur pour systemd + le cache
# Chromium). Le script appelle `sudo` lui-même pour les étapes privilégiées.
#
# Étapes : deps système → Node → driver imprimante Rollo → file CUPS (auto-
# détectée) → npm install → service systemd. Le .env reste à remplir à la main.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROLLO_VERSION="1.8.4"
ROLLO_URL="https://rollo-main.b-cdn.net/driver-dl/linux/rollo-cups-driver-${ROLLO_VERSION}.tar.gz"
PRINTER_NAME="${PRINTER_NAME:-Munbyn}"

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_USER="$(id -un)"
NODE_BIN="$(command -v node || true)"

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m  ✘ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$EUID" -eq 0 ] && die "Ne lance PAS ce script en root/sudo. Lance-le en simple utilisateur : ./setup.sh"
command -v sudo >/dev/null || die "sudo est requis."

# ── 1. Paquets système (CUPS, libs Chromium pour Puppeteer, outils de build) ──
say "1/6 Paquets système"
sudo apt-get update -qq
sudo apt-get install -y \
  cups \
  build-essential libcups2-dev libcupsimage2-dev \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 libasound2 \
  wget curl ca-certificates
ok "Paquets installés"

# ── 2. Node.js >= 18 (NodeSource si absent ou trop vieux) ─────────────────────
say "2/6 Node.js"
NODE_MAJOR=0
if [ -n "$NODE_BIN" ]; then NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"; fi
if [ "$NODE_MAJOR" -lt 18 ]; then
  warn "Node absent ou < 18 → installation de Node 20 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
NODE_BIN="$(command -v node)"
ok "Node $(node -v) ($NODE_BIN)"

# ── 3. Driver imprimante Rollo (filtre rastertorollo + PPD) ───────────────────
say "3/6 Driver imprimante (Rollo/Beeprt)"
if [ -x /usr/lib/cups/filter/rastertorollo ]; then
  ok "Driver déjà installé (rastertorollo présent)"
else
  TMP="$(mktemp -d)"
  ( cd "$TMP"
    wget -q "$ROLLO_URL"
    tar xzf "rollo-cups-driver-${ROLLO_VERSION}.tar.gz"
    cd "rollo-cups-driver-${ROLLO_VERSION}"
    ./configure
    make
    sudo make install )
  rm -rf "$TMP"
  [ -x /usr/lib/cups/filter/rastertorollo ] || die "Échec installation driver Rollo."
  ok "Driver Rollo compilé et installé"
fi

# ── 4. File d'impression CUPS (URI USB auto-détectée) ─────────────────────────
say "4/6 File CUPS « $PRINTER_NAME »"
sudo usermod -aG lpadmin,lp "$RUN_USER" || true
URI="$(sudo lpinfo -v 2>/dev/null | awk '/usb:.*ITPP130/{print $2; exit}')"
if [ -z "$URI" ]; then
  URI="$(sudo lpinfo -v 2>/dev/null | awk '/usb:.*(Printer|Label)/{print $2; exit}')"
fi
[ -z "$URI" ] && die "Imprimante USB introuvable. Branche/allume la Munbyn puis relance. (sudo lpinfo -v pour debug)"
ok "Imprimante détectée : $URI"
sudo lpadmin -p "$PRINTER_NAME" -E -v "$URI" -m rollo-x1038.ppd -o PageSize=4x6 -o printer-is-shared=false
sudo cupsaccept "$PRINTER_NAME"
sudo cupsenable "$PRINTER_NAME"
ok "File « $PRINTER_NAME » prête (PageSize 4x6 = 100×150 mm)"

# ── 5. Dépendances Node (firebase-admin, puppeteer, qrcode) ───────────────────
say "5/6 Dépendances Node"
( cd "$APP_DIR" && npm install --no-fund --no-audit )
ok "node_modules + Chromium Puppeteer installés"

# ── 6. .env + service systemd ─────────────────────────────────────────────────
say "6/6 Configuration & service systemd"
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  warn ".env créé depuis .env.example — À REMPLIR (voir fin de script)"
fi

UNIT=/etc/systemd/system/feels-print.service
sudo tee "$UNIT" >/dev/null <<UNITEOF
[Unit]
Description=FEEL's auto-impression cuisine (Firestore -> $PRINTER_NAME)
After=network-online.target cups.service
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNITEOF
sudo systemctl daemon-reload
ok "Service systemd installé ($UNIT)"

# ── Démarrage auto seulement si le .env est renseigné ─────────────────────────
ENV_OK=1
grep -qE '^SERVICE_ACCOUNT_PATH=..' "$APP_DIR/.env" || ENV_OK=0
grep -qE '^KITCHEN_OPERATOR_ID=..'  "$APP_DIR/.env" || ENV_OK=0
if [ "$ENV_OK" -eq 1 ]; then
  sudo systemctl enable --now feels-print
  ok "Service démarré (enable --now). Logs : journalctl -u feels-print -f"
else
  sudo systemctl enable feels-print
  warn "Service activé au boot mais PAS démarré : remplis d'abord le .env."
fi

cat <<FINI

────────────────────────────────────────────────────────────────────────────
✅ Installation terminée.

À RENSEIGNER dans  $APP_DIR/.env :
  • SERVICE_ACCOUNT_PATH  → chemin de la clé service account Firebase (JSON).
                            Dépose le JSON dans $APP_DIR/ (ex: ./service-account.json)
  • KITCHEN_OPERATOR_ID   → id de la cuisine à écouter (champ kitchenOperatorId).
  • PRINTER_NAME          → « $PRINTER_NAME » (déjà cohérent avec la file CUPS).

Test imprimante (sans Firebase) :
  cd $APP_DIR && node src/render-test.js && lp -d $PRINTER_NAME ticket-test.pdf

Une fois le .env rempli :
  sudo systemctl restart feels-print
  journalctl -u feels-print -f      # doit afficher « en écoute des nouvelles commandes… »
────────────────────────────────────────────────────────────────────────────
FINI
