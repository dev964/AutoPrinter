# ── Base : Node 20 sur Debian bookworm (slim = allégée) ─────────────────────
FROM node:20-bookworm-slim

# ── Paquets système : Chromium (pour Puppeteer), client CUPS (commande `lp`),
#    et polices (accents + emojis du ticket) ──────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    cups-client \
    fonts-liberation \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# ── Config Puppeteer : on utilise le Chromium d'apt, pas celui que Puppeteer
#    télécharge par défaut ──────────────────────────────────────────────────
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app

# ── 1) Dépendances D'ABORD (couche mise en cache tant que package*.json
#    ne bouge pas) ─────────────────────────────────────────────────────────
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── 2) Code ENSUITE (change souvent → tout en bas pour préserver le cache) ──
COPY src/ ./src/

# ── Commande lancée au démarrage du conteneur ───────────────────────────────
CMD ["node", "src/index.js"]
