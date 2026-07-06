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
# Étapes : deps système → Node → drivers (Rollo + POS80) → files CUPS → npm → systemd.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROLLO_VERSION="1.8.4"
ROLLO_URL="https://rollo-main.b-cdn.net/driver-dl/linux/rollo-cups-driver-${ROLLO_VERSION}.tar.gz"
MUNBYN_QUEUE="${MUNBYN_QUEUE:-Munbyn}"
POS80_QUEUE="${POS80_QUEUE:-POS80}"
POS80_DRIVER_INSTALL="${POS80_DRIVER_INSTALL:-$HOME/Downloads/80MM Thermal Printer Driver & Tools/Printer Driver/Linux Driver/linux64bit/install80}"

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_USER="$(id -un)"
NODE_BIN="$(command -v node || true)"

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m  ✘ %s\033[0m\n' "$*" >&2; exit 1; }

usb_uri_for() {
  local pattern="$1"
  sudo lpinfo -v 2>/dev/null | awk -v p="$pattern" '$0 ~ p {print $2; exit}'
}

setup_munbyn_queue() {
  local uri
  uri="$(usb_uri_for 'usb:.*ITPP130')"
  [ -z "$uri" ] && uri="$(usb_uri_for 'usb:.*(Label|ITPP)')" || true
  if [ -z "$uri" ]; then
    warn "Munbyn (ITPP130) non détectée en USB — file « $MUNBYN_QUEUE » ignorée."
    return 1
  fi
  ok "Munbyn détectée : $uri"
  sudo lpadmin -p "$MUNBYN_QUEUE" -E -v "$uri" -m rollo-x1038.ppd -o PageSize=4x6 -o printer-is-shared=false
  sudo cupsaccept "$MUNBYN_QUEUE"
  sudo cupsenable "$MUNBYN_QUEUE"
  ok "File « $MUNBYN_QUEUE » prête (100×150 mm)"
}

setup_pos80_queue() {
  local uri
  # ZiJiang POS80 : souvent « Printer » sans ITPP130 ; on évite de reprendre la Munbyn.
  uri="$(sudo lpinfo -v 2>/dev/null | awk '/usb:/{print $2}' | grep -vi 'ITPP130' | head -1)"
  if [ -z "$uri" ]; then
    warn "POS80 non détectée en USB — file « $POS80_QUEUE » ignorée."
    return 1
  fi
  ok "POS80 détectée : $uri"
  sudo lpadmin -p "$POS80_QUEUE" -E -v "$uri" -m POS80.ppd -o printer-is-shared=false 2>/dev/null \
    || sudo lpadmin -p "$POS80_QUEUE" -E -v "$uri" -P /usr/share/cups/model/zjiang/POS80.ppd -o printer-is-shared=false
  sudo cupsaccept "$POS80_QUEUE"
  sudo cupsenable "$POS80_QUEUE"
  ok "File « $POS80_QUEUE » prête (80 mm)"
}

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

# ── 3. Drivers imprimantes (Rollo/Munbyn + ZiJiang POS80) ─────────────────────
say "3/7 Driver Munbyn (Rollo/Beeprt)"
if [ -x /usr/lib/cups/filter/rastertorollo ]; then
  ok "Driver Rollo déjà installé"
else
  TMP="$(mktemp -d)"
  ( cd "$TMP"
    wget -q "$ROLLO_URL"
    tar xzf "rollo-cups-driver-${ROLLO_VERSION}.tar.gz"
    cd "rollo-cups-driver-${ROLLO_VERSION}"
    ./configure && make && sudo make install )
  rm -rf "$TMP"
  [ -x /usr/lib/cups/filter/rastertorollo ] || die "Échec installation driver Rollo."
  ok "Driver Rollo compilé et installé"
fi

say "4/7 Driver POS80 (ZiJiang)"
if [ -x /usr/lib/cups/filter/rastertozj ]; then
  ok "Driver POS80 déjà installé"
elif [ -f "$POS80_DRIVER_INSTALL" ]; then
  sudo sh "$POS80_DRIVER_INSTALL" </dev/null || die "Échec installation driver POS80."
  [ -x /usr/lib/cups/filter/rastertozj ] || warn "rastertozj absent après install — vérifier le driver."
  ok "Driver POS80 installé"
else
  warn "Driver POS80 introuvable ($POS80_DRIVER_INSTALL) — saute l'installation POS80."
  warn "Définir POS80_DRIVER_INSTALL=/chemin/vers/install80 puis relancer."
fi

# ── 4. Files CUPS (détection USB) ─────────────────────────────────────────────
say "5/7 Files CUPS"
sudo usermod -aG lpadmin,lp "$RUN_USER" || true
MUNBYN_OK=0; POS80_OK=0
setup_munbyn_queue && MUNBYN_OK=1 || true
if [ -x /usr/lib/cups/filter/rastertozj ] || [ -f /usr/share/cups/model/zjiang/POS80.ppd ]; then
  setup_pos80_queue && POS80_OK=1 || true
fi
if [ "$MUNBYN_OK" -eq 0 ] && [ "$POS80_OK" -eq 0 ]; then
  die "Aucune imprimante USB détectée. Branche-les puis relance (sudo lpinfo -v)."
fi

# ── 5. Dépendances Node ───────────────────────────────────────────────────────
say "6/7 Dépendances Node"
( cd "$APP_DIR" && npm install --no-fund --no-audit )
ok "node_modules + Chromium Puppeteer installés"

# ── 6. .env + service systemd ─────────────────────────────────────────────────
say "7/7 Configuration & service systemd"
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  warn ".env créé depuis .env.example — À REMPLIR (voir fin de script)"
fi

UNIT=/etc/systemd/system/feels-print.service
sudo tee "$UNIT" >/dev/null <<UNITEOF
[Unit]
Description=FEEL's auto-impression cuisine (Firestore -> CUPS)
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
  • SERVICE_ACCOUNT_PATH  → clé service account Firebase (JSON).
  • KITCHEN_OPERATOR_ID   → id de la cuisine (kitchenOperatorId).
  • PRINTERS              → profils, ex: munbyn:$MUNBYN_QUEUE:100x150,pos80:$POS80_QUEUE:80mm
  • ACTIVE_PRINTER        → munbyn ou pos80 (imprimante utilisée par le service)

Lister / tester :
  node src/index.js --list-printers
  node src/index.js --test-print                    # imprimante active
  node src/index.js --test-print --printer=pos80    # forcer une imprimante
  node src/render-test.js --printer=munbyn

Une fois le .env rempli :
  sudo systemctl restart feels-print
  journalctl -u feels-print -f      # doit afficher « en écoute des nouvelles commandes… »
────────────────────────────────────────────────────────────────────────────
FINI
