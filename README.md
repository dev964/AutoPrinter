# FEEL's — Service d'auto-impression cuisine

Petit service Node qui **écoute Firestore** (collection `foodOrders`) exactement
comme l'écran cuisine de l'app, et **imprime le ticket client identique** dès
qu'une nouvelle commande confirmée arrive — sur l'imprimante **Munbyn** via CUPS.

Remplace le mécanisme `--kiosk-printing` de Chrome (qui n'existe pas sur les
navigateurs Android/Kiwi des tablettes). Tourne sur un PC sous **Debian 12**.

## Ce que ça fait

- Réplique la requête de `KitchenBoardPage` : commandes de `kitchenOperatorId`,
  statut actif (`pending/accepted/preparing/ready_for_assembly`).
- Filtre `isOrderConfirmed` (paiement confirmé / comptoir / repas perso) et
  exclut les commandes de test.
- **Anti-rafale** : au démarrage, mémorise les commandes déjà présentes **sans
  imprimer** ; n'imprime que celles qui arrivent ensuite, **une fois chacune**.
- Rendu du ticket **identique** à `printTicketClient.ts` (TVA, formules, QR
  Instagram) via Puppeteer/Chromium → PDF 100×150 → `lp`.

## Installation express (serveur Debian/Ubuntu)

Tout est automatisé par `setup.sh` (deps, Node, driver imprimante, file CUPS
auto-détectée, dépendances Node, service systemd). À lancer **en simple
utilisateur** (pas en root), imprimante branchée en USB :

```bash
./setup.sh
```

Puis remplir le `.env` (voir plus bas) et `sudo systemctl restart feels-print`.
Les sections ci-dessous détaillent les étapes manuelles si besoin.

## Prérequis (Debian 12)

1. **Node.js ≥ 18** :
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
   sudo apt install -y nodejs
   ```
2. **CUPS + dépendances Chromium** (pour Puppeteer) :
   ```bash
   sudo apt install -y cups libnss3 libatk1.0-0 libatk-bridge2.0-0 \
     libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
     libxrandr2 libgbm1 libpango-1.0-0 libasound2
   ```
3. **Driver Munbyn x86_64** (CUPS) depuis le support Munbyn, puis ajouter
   l'imprimante (USB recommandé) et régler son **média par défaut sur
   100×150 mm, marges 0**. Vérifier le nom de la file :
   ```bash
   lpstat -p          # -> note le nom exact, à mettre dans PRINTER_NAME
   ```

## Installation

```bash
cd imprimante
npm install                 # installe firebase-admin, puppeteer, qrcode
cp .env.example .env        # puis éditer .env
```

Renseigner dans `.env` :
- `SERVICE_ACCOUNT_PATH` : clé service account Firebase (Console → Paramètres →
  Comptes de service → Générer une clé privée). Déposer le JSON ici, **ne pas
  le committer**.
- `KITCHEN_OPERATOR_ID` : l'id de la cuisine (champ `kitchenOperatorId` des
  commandes).
- `PRINTER_NAME` : le nom CUPS relevé via `lpstat -p`.

## Tester

Test imprimante seul (sans Firebase) — imprime un faux ticket :
```bash
npm run print-test
```
Puis le service réel :
```bash
npm start
```
Passe une vraie commande de test depuis l'app : le ticket doit sortir.

## Lancement au démarrage (systemd)

Voir `feels-print.service` (adapter `User`, `WorkingDirectory`, `ExecStart`),
puis :
```bash
sudo cp feels-print.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now feels-print
journalctl -u feels-print -f
```

## Maintenance

La logique TVA / formules / mise en page est **portée** depuis le monorepo
(`src/lib.js` et `src/ticket.js`). Si l'app modifie `printTicketClient.ts`,
`vat.ts` ou `menuFormula.ts`, resynchroniser ces deux fichiers.
