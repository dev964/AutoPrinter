# Impression pilotée par Firebase — côté serveur (script d'impression)

> **Partie serveur** de la migration « impression FEEL's ».
> La partie site (app restaurant) est documentée dans
> `drop-platform/apps/restaurant/IMPRESSION-SERVEUR.md` du dépôt `dropv2`.
> **Le modèle de données Firestore (§3) est un contrat commun aux deux côtés.**

## 1. Contexte

Ce service Node (`src/index.js`) écoute Firestore (`foodOrders`) et imprime le
ticket client sur la Munbyn via CUPS. Aujourd'hui il imprime **toujours** les
nouvelles commandes confirmées (anti-rafale au démarrage) ; il n'y a **aucun
interrupteur** et **aucun moyen de demander l'impression d'un ticket précis**.

En parallèle, l'app restaurant imprime **aussi** côté navigateur
(`window.print()`), avec un flag d'auto-impression stocké en `localStorage` →
propre à chaque appareil. Résultat : impressions en double possibles, et état
d'auto-impression non partagé.

### Cible

Le **script devient la seule autorité d'impression**. Le site n'imprime plus :
il **écrit des signaux dans Firebase**, le script écoute et imprime.

| Canal Firestore | Rôle | Écrit par | Lu par |
|---|---|---|---|
| `printSettings/{operatorId}` | Flag auto-impression **global partagé** | Site | **Ce script** (+ tous les sites) |
| `printJobs/{id}` | Demande d'impression **d'un ticket précis** | Site | **Ce script** |

```
[App restaurant — plusieurs appareils]  ─►  Firestore  ─►  [CE SCRIPT]  ─►  CUPS / Munbyn
                                            settings+jobs     (seule à imprimer)
```

## 2. `KITCHEN_OPERATOR_ID` = `kitchenOperatorId` = `operatorId`

Le même identifiant de cuisine COP'EAT est utilisé des deux côtés. Ici c'est la
variable d'environnement **`KITCHEN_OPERATOR_ID`** (déjà présente dans `.env`),
et c'est la **clé** des docs `printSettings/{KITCHEN_OPERATOR_ID}` et du filtre
`printJobs.where('kitchenOperatorId', '==', KITCHEN_OPERATOR_ID)`.

## 3. Modèle de données Firestore (contrat commun aux deux côtés)

### `printSettings/{kitchenOperatorId}` — doc unique, état partagé
| Champ | Type | Écrit par | Notes |
|---|---|---|---|
| `autoPrintEnabled` | `boolean` | site | flag global — **ce script le LIT seulement** |
| `updatedAt` | `Timestamp` | site | |
| `updatedBy` | `string` | site | uid du staff |

### `printJobs/{autoId}` — une demande manuelle = un document
| Champ | Type | Écrit par | Notes |
|---|---|---|---|
| `kitchenOperatorId` | `string` | site | filtre |
| `orderId` | `string` | site | commande `foodOrders` à imprimer |
| `status` | `'pending' \| 'printing' \| 'printed' \| 'failed'` | site crée `pending` ; **ce script fait avancer** | anti-doublon |
| `requestedAt` | `Timestamp` | site | |
| `requestedBy` | `string` | site | uid |
| `source` | `string?` | site | `mise-en-sac` / `cuisine` / `historique` |
| `printedAt` | `Timestamp` | **ce script** | à l'impression réussie |
| `error` | `string` | **ce script** | si `failed` |

L'Admin SDK **bypasse les règles Firestore** : ce script lit/écrit librement.

## 4. Modifications à faire (`src/index.js`)

### 4.1 Écouter le flag d'auto-impression (partagé)
- `onSnapshot(db.collection('printSettings').doc(KITCHEN_OPERATOR_ID))` →
  garder `autoPrintEnabled` en mémoire. Si le doc n'existe pas encore, valeur par
  défaut `false`.

### 4.2 Gater l'auto-impression sur le flag
Dans le watcher `foodOrders` existant (la boucle qui `printQueue.push(o)`) :
- **N'imprimer que si `autoPrintEnabled`** est vrai.
- **Conserver l'anti-rafale** (seeding : au 1er snapshot on mémorise l'existant
  sans imprimer).
- **Marquer `seen` même quand le flag est OFF** — comme le fait déjà le site —
  pour qu'au rallumage on n'imprime pas d'un coup toutes les commandes arrivées
  pendant l'extinction (seuls les **nouveaux** événements impriment).
  ```js
  if (seen.has(o.id)) continue;
  if (isTestOrder(o)) { seen.add(o.id); continue; }
  if (!isOrderConfirmed(o)) continue;   // pas encore confirmé : réévalué plus tard
  seen.add(o.id);                        // vu, qu'on imprime ou non
  if (autoPrintEnabled) { printQueue.push(o); void drainQueue(...); }
  ```

### 4.3 Nouveau watcher `printJobs` (impression manuelle d'un ticket)
- `db.collection('printJobs')
     .where('kitchenOperatorId', '==', KITCHEN_OPERATOR_ID)
     .where('status', '==', 'pending')
     .onSnapshot(...)`
- Pour chaque job `pending` :
  1. **Réclamer le job** : `pending → printing` via `runTransaction`/`updateDoc`
     conditionnel (anti-doublon si double-clic, snapshots répétés, ou redémarrage).
  2. `getDoc(foodOrders/{orderId})` → `renderTicketHtml(db, order, dailyMessage)`.
  3. **Réutiliser la `printQueue` sérialisée existante** (une seule imprimante
     partagée entre auto et manuel).
  4. Succès → `status: 'printed'`, `printedAt`. Échec → `status: 'failed'`,
     `error: e.message`.
- **Garde-fou au démarrage** : marquer `failed` (`error: 'obsolète au
  redémarrage'`) les `pending` plus vieux que N minutes, pour ne pas rejouer de
  vieilles demandes au boot.

L'anti-doublon (`pending → printing`) est **par job**, pas par commande : un même
document n'est imprimé qu'une fois, mais plusieurs jobs pour la même commande
donnent plusieurs impressions. La réimpression manuelle est donc toujours
possible, même si la commande a déjà été auto-imprimée — le `seen` de l'auto-print
(§4.2) ne concerne que le watcher `foodOrders`, jamais `printJobs`.

### 4.4 Réutilisation
- `renderTicketHtml` (`src/ticket.js`), `printHtml` (`src/print.js`),
  `isOrderConfirmed` (`src/lib.js`), la `printQueue`/`drainQueue` : **inchangés**,
  réutilisés tels quels pour l'auto ET le manuel.

### 4.5 Attendre le numéro de commande avant d'imprimer (bug `#ref`)

**Symptôme** : le ticket sort souvent avec `#a1b2c3` (repli sur l'id) au lieu de
`N°42` (`dailyOrderNumber`).

**Cause** : `dailyOrderNumber` est posé **de façon asynchrone** par le trigger
Cloud Function `assignFoodOrderNumber`
(`drop-platform/functions/src/food/assignFoodOrderNumber.ts`), déclenché par le
**même** write qui rend la commande confirmée (`paymentStatus: captured` /
comptoir / repas perso). Le listener d'impression (snapshot local) réagit
**avant** que le trigger (latence d'invocation + transaction) n'ait écrit le
numéro. On imprime donc sans numéro, puis on marque `seen` → le snapshot suivant
(numéro posé) est ignoré. Vérifié : `isOrderConfirmed` (déclencheur impression)
et `isKitchenReal` (déclencheur numéro) **coïncident** → toute commande imprimée
**finit toujours** par recevoir un numéro ; ce n'est donc **qu'un problème de
timing**, pas de commandes sans numéro.

**Correctif** (dans le watcher `foodOrders`, auto-print) : ne pas marquer `seen`
ni imprimer tant que le numéro n'est pas là ; attendre le snapshot où le trigger
le pose ; **repli borné** si le trigger n'arrive jamais.

```js
if (seen.has(o.id)) continue;
if (isTestOrder(o)) { seen.add(o.id); continue; }
if (!isOrderConfirmed(o)) continue;              // pas confirmé → réévalué plus tard

// Numéro pas encore posé par assignFoodOrderNumber → on attend (NE PAS marquer seen).
if (typeof o.dailyOrderNumber !== 'number') {
  armFallback(o.id);   // arme UNE fois un setTimeout (~8 s) qui imprimera au repli
  continue;            // le snapshot où le trigger pose le numéro repassera ici
}

clearFallback(o.id);   // le numéro est arrivé à temps
seen.add(o.id);
if (autoPrintEnabled) { printQueue.push(o); void drainQueue(...); }
```

- Chemin nominal : quand le trigger pose `dailyOrderNumber`, un nouveau snapshot
  arrive **avec** le numéro → on imprime `N°42`.
- Repli (`armFallback`) : comme les snapshots ne se redéclenchent que sur
  changement, un `setTimeout` (~8 s) force l'impression avec `#ref` si le trigger
  a échoué — un ticket sans numéro reste préférable à pas de ticket.
- **Impression manuelle** (`printJobs`) : le clic vient d'une carte déjà
  affichée, donc le numéro est en général présent ; le handler lit la commande à
  frais (`getDoc`) et peut faire la même courte attente si le numéro manque.
- La même course existe aujourd'hui côté navigateur (`ProductionScreenPage`) ;
  elle **disparaît** dès que l'impression passe côté serveur (cf. README site).

## 5. Cas limites à couvrir
- **Numéro de commande absent** (`#ref` au lieu de `N°42`) : attente + repli
  borné, cf. §4.5.
- **Rafale au boot** : seeding déjà en place → conservé.
- **Rallumage du flag** : `seen` marqué même OFF → pas de rafale (cf. 4.2).
- **Double-clic / snapshots répétés / restart** : transition `status` en
  transaction → un ticket imprimé une seule fois.
- **Vieux `printJobs`** au démarrage : garde-fou d'ancienneté (§4.3) + **TTL
  Firestore** sur `requestedAt` pour le nettoyage automatique de la collection.
- **Une seule imprimante** : auto + manuel passent par la même file sérialisée.
- **Échec** : `status:'failed'` + `error` → le site peut afficher un toast.

## 6. Ordre de déploiement (côté serveur)
1. Le site crée le modèle de données + `printSettings/{operatorId}` avec
   `autoPrintEnabled: false`.
2. **Déployer ce script** (lit le flag, traite `printJobs`) — passif tant que le
   flag est `false` : `sudo systemctl restart feels-print`.
3. Le site retire son impression navigateur.
4. Passer `autoPrintEnabled: true`. Aucune fenêtre de double impression.

## 7. Rappel maintenance
Le rendu du ticket (`src/ticket.js`, `src/lib.js`) est **porté** depuis le
monorepo (`printTicketClient.ts`, `vat.ts`, `menuFormula.ts`). Si l'app modifie
ces fichiers, resynchroniser — voir `README.md`. `src/reprint.js` (réimpression
CLI) reste disponible en secours indépendamment de ce mécanisme.
