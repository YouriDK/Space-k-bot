# Space-K Bot

Bot d'automatisation pour **Space-K**, un jeu de stratégie spatiale de type OGame hébergé comme application interne.
Il parle à l'API du jeu, tourne **24/7 sur un vieux téléphone Android** (Termux) et se pilote **depuis Telegram**.

**Ce qu'il fait pour vous, sans intervention :**

- 🛡 **Fleet-save** — 10 s avant qu'une sonde ou une attaque ne touche une planète, toute la flotte décolle
  avec un maximum de ressources, puis rentre juste après le passage. L'attaquant trouve une planète vide.
- 🏗 **Auto-construction** — enchaîne les bâtiments selon une liste d'objectifs, planète par planète,
  en gérant l'énergie, les réservoirs pleins et les files occupées ; Père finance ce que les colonies ne peuvent pas payer.
- 🤖 **Flotte automatique** — un type de vaisseau par planète, construit avec le seul surplus de Père (les bâtiments d'abord).
- 🔬 **Graviton automatique** — lancé depuis Père dès que son labo 12 le débloque.
- ⏭ **`/next`** — met une construction ou une recherche en attente : elle part dès que la file se libère,
  y compris en pleine nuit.
- ☠ **Veille pirates** — annonce chaque nouvelle cache/repaire/bastion/citadelle avec le raid conseillé (Telegram + Discord).
- ♻️ **Récupération** — envoie des recycleurs sur les champs de débris et des éclaireurs sur les cargaisons abandonnées.
- 🔔 **Notifications** — bâtiment, recherche ou chantier terminés, sondage subi, attaque en approche, impact, rapports de combat, erreurs.

**Ce que vous déclenchez depuis Telegram :** raids sur presets, scans d'un joueur entier, expéditions,
ravitaillement entre planètes, constructions, recherches — chaque action réelle demande une confirmation ✅.

Les actions automatiques historiques sont **désarmées par défaut** : le bot annonce ce qu'il *aurait* fait
tant que vous ne l'avez pas armé (`/save on`, `/collect on`, `/autobuild <planète> on`…). Exceptions, **allumées par défaut**
(décision du 05/10/2026) : le financement des bâtiments des colonies par Père, Graviton automatique et la flotte automatique
(`/autobuild finance off`, `/autobuild graviton off`, `/autofleet <planète> off` pour les couper).

> Le détail de l'API du jeu (auth, endpoints, formats, formules) est dans [`space-k-api.md`](space-k-api.md).
> Chaque information y est marquée **[TESTÉ]** (appelée en live), **[BUNDLE]** (lue dans le code client),
> **[DÉDUIT]** ou **[HYPOTHÈSE]** — rien n'est inventé.

## Installation

### 1. Sur la machine de développement

```bash
git clone <ce-dépôt> && cd spacek-bot
npm install
cp .env.example .env        # puis remplir (voir Configuration)
npm run typecheck
```

### 2. Récupérer le jeton d'accès

Le bot n'a besoin que d'un **refresh token Keycloak** pour régénérer tout le reste (il dure 7 jours d'inactivité
et se renouvelle tout seul tant que le bot tourne).

1. Ouvrir le portail du jeu dans une **fenêtre de navigation privée** et se connecter.
2. Console du navigateur : `copy(localStorage.refresh_token)`.
3. Fermer la fenêtre **sans se déconnecter** (un logout invaliderait le jeton).
4. Coller la valeur dans `refresh_token.txt` (`chmod 600`).

La fenêtre privée évite que le navigateur habituel et le bot se disputent la rotation du jeton.
Plus tard, le renouvellement se fait sans SSH : `/token <valeur>` depuis Telegram.

### 3. Bot Telegram

1. Parler à **@BotFather** → `/newbot` → récupérer le token → `TG_TOKEN` dans `.env`.
2. Lancer `npm run telegram` avec `TG_CHAT_ID` vide, écrire au bot : il répond votre chat id.
3. Mettre ce chat id dans `TG_CHAT_ID`. Le bot n'obéira qu'à cette conversation et ignorera tout le reste.

### 4. Serveur Android (Termux)

Le bot est conçu pour un téléphone branché en permanence : consommation négligeable, pas de port ouvert
(Telegram fonctionne en *long polling*), et il survit aux redémarrages.

```bash
# Depuis l'ordinateur, téléphone branché en USB, débogage activé :
adb install termux-app.apk termux-boot.apk termux-api.apk      # versions GitHub, pas Play Store

# Android 12+ tue les processus en arrière-plan : à désactiver
adb shell "/system/bin/device_config put activity_manager max_phantom_processes 2147483647"
adb shell "settings put global settings_enable_monitor_phantom_procs false"
adb shell "device_config set_sync_disabled_for_tests persistent"
adb shell "dumpsys deviceidle whitelist +com.termux"

# Dans Termux : pkg install openssh nodejs, ajouter sa clé SSH, puis sshd
# Première copie du projet (une seule fois ; ensuite les mises à jour passent par /maj, voir plus bas) :
scp *.ts *.json *.sh <user>@<ip-du-téléphone>:spacek-bot/    # port 8022
ssh <user>@<ip-du-téléphone> "cd spacek-bot && bash setup-termux.sh"
```

Le `scp` ci-dessus ne sert qu'à **la toute première installation** (il copie aussi les `*.json` : à ne plus jamais
refaire une fois le bot en service, il écraserait `build-plan.json` et l'état du téléphone). Les mises à jour se font
ensuite depuis Telegram avec `/maj` (section suivante).

`setup-termux.sh` installe les dépendances, `pm2`, le script de démarrage automatique (Termux:Boot)
et crée un `.env` en mode observation. Ensuite :

```bash
pm2 start "npx tsx --env-file=.env telegram.ts" --name spacek && pm2 save
pm2 logs spacek
```

Points d'attention : exclure Termux de l'optimisation de batterie, garder `termux-wake-lock` actif,
et ne pas balayer l'application hors des récentes.

### 4b. Mises à jour depuis Telegram (`/maj`)

Le téléphone se met à jour tout seul depuis GitHub (`https://github.com/YouriDK/Space-k-bot`, branche `main`),
sans le Mac ni le même réseau : on pousse sur `main`, puis `/maj` sur Telegram.

**Installation (une seule fois, dans Termux)** — le bot doit déjà tourner sous pm2 (`spacek`) :

```bash
pkg install -y git curl
curl -fsSL https://raw.githubusercontent.com/YouriDK/Space-k-bot/main/update.sh | bash
```

Cela clone le dépôt dans `~/spacek-repo`, déploie la dernière version dans `~/spacek-bot` (mêmes règles que `/maj`
ci-dessous) et redémarre le bot, qui confirme sur Telegram. Ce premier lancement ne peut pas vérifier le fleet-save :
le faire quand aucune menace n'est en cours (`/threats`). Si le process pm2 `spacek` n'existe pas encore, le code est
copié sans redémarrage et le script rappelle les étapes de `setup-termux.sh`.

**Fonctionnement de `/maj`** (alias `/update`) :
1. `git fetch` dans `~/spacek-repo` (clone créé au premier appel), comparaison avec `~/spacek-bot/.version`
   (sha déployé) → « déjà à jour », ou la liste des commits à déployer et ✅ Confirmer / ❌ Annuler.
2. Refus si un **fleet-save est en vol** (son rappel n'existe qu'en mémoire : un redémarrage le perdrait) ou si le
   save est armé et qu'une menace arrive dans moins de 5 min. Revérifié au moment du ✅.
3. Au ✅, le bot lance `update.sh` **détaché** (ré-attaché à init : il survit au `pm2 restart`, qui tue l'arbre de
   processus du bot). Le script se ré-exécute depuis le clone (la logique de mise à jour est celle de la version
   déployée), sauvegarde le code actuel dans `~/spacek-backups/<date-heure>-avant-maj/` (10 gardées), copie les
   nouveaux fichiers, écrit le marqueur `.update-pending` puis fait `pm2 restart spacek`.
4. Le nouveau bot, une fois en place (15 s de fonctionnement et Telegram joignable), envoie
   « ✅ Mise à jour en place : <ancien> → <nouveau> » et supprime le marqueur.

**Retour arrière automatique** : si le marqueur est encore là 90 s après le redémarrage (le nouveau code ne démarre
pas), `update.sh` remet les fichiers sauvegardés, supprime ceux que la mise à jour avait ajoutés, refait
`pm2 restart`, et envoie lui-même (curl, jetons lus dans `.env`) « ❌ Mise à jour <sha> annulée » avec les dernières
lignes de `pm2 logs`. Le jeu injoignable ne déclenche pas de retour arrière (seul Telegram est vérifié).

**Jamais écrasé** : seuls les fichiers suivis par git **hors `*.json`** sont copiés (`*.ts`, `*.sh`, `README.md`,
`space-k-api.md`, `.env.example`, `.gitignore`). Ne sont jamais touchés : tous les `*.json` (dont `build-plan.json`,
qui porte les vraies activations d'autobuild, `package.json`, `package-lock.json`, `tsconfig.json`), `.env`,
`refresh_token.txt*`, les `*.jsonl`. Si `package.json` ou `package-lock.json` diffère du dépôt, c'est signalé
(récapitulatif et message de fin) : `npm install` reste à faire à la main.

Journal : `~/spacek-bot/update.log` · verrou `~/spacek-bot/.update-lock` (une mise à jour à la fois).
À la main (ssh) : `bash ~/spacek-bot/update.sh` fait la même chose, sans la vérification du fleet-save.

### 5. Discord (optionnel)

Salon → Intégrations → Webhooks → Nouveau webhook → copier l'URL dans `DISCORD_WEBHOOK_URL`.
Aucun bot Discord n'est nécessaire : le serveur reçoit un simple POST. **Seules les alertes pirates** y sont publiées.

## Configuration

| Fichier | Rôle |
|---|---|
| `.env` | Jetons, flags de départ, réglages (voir `.env.example`) — jamais commité |
| `build-plan.json` | Objectifs d'auto-construction, plafonds et activation par planète, financement / Graviton (`defaults`) — rechargé à chaud, migré au chargement (`defaults.version`) |
| `refresh_token.txt` | Jeton Keycloak, tourné automatiquement (`.bak` conservé) — jamais commité |
| `flags.json`, `next-build.json`, `supply.json`, `fleet-build.json`, `build-fund.json`, `auto-fleet.json`, `seen.json` | État persistant du bot, écrit à l'exécution |
| `.version`, `.update-pending`, `update.log` | Mise à jour `/maj` : sha déployé, marqueur en attente de confirmation, journal |

`HOME_PLANET` désigne la planète qui sert de hub (départ des raids, scans, expéditions et ravitaillements).
Les identifiants de planètes, clés de bâtiments et de vaisseaux viennent tous de `/api/state`.

## Structure du code

| Fichier | Rôle |
|---|---|
| `spacek-client.ts` | Client API : chaîne d'authentification complète, rotation atomique du jeton, retry 401, un wrapper par endpoint |
| `bot.ts` | Boucle de poll, fleet-save, ravitaillement, collecte, capture de données |
| `telegram.ts` | Commandes, confirmations, notifications, heartbeat |
| `maj.ts` | `/maj` : clone et commits à déployer, lancement détaché d'`update.sh`, confirmation au démarrage |
| `update.sh` | Mise à jour du téléphone depuis GitHub : sauvegarde, copie, `pm2 restart`, retour arrière |
| `setup-termux.sh` | Installation côté téléphone |
| `space-k-api.md` | Référence de l'API du jeu |

## Fonctionnalités

Tout démarre en **mode observation** : les flags `SAVE_ARMED`, `COLLECT_ENABLED`, `EXPLO_AUTO`, `DEUT_COLLECT_ENABLED` sont à `false`.
Le bot calcule, logue et notifie « j'AURAIS décollé / envoyé », mais n'émet aucun POST automatique.
Auto-construction et auto-ravitaillement n'ont pas de flag : ils s'activent planète par planète (`/autobuild <planète> on`, `/autosupply <planète> on`), rien n'est actif par défaut.
Financement des colonies, Graviton auto et flotte auto sont, eux, **allumés par défaut** (sections 8d et 8e) ; `/pause` les suspend aussi.
Les flags se changent à chaud via Telegram (`/save on`, `/collect on`, `/autoexplo on`, `/autodeut on`, `/pause`, `/resume`) ; `/pause` coupe aussi l'expédition auto et le deut→Père et suspend aussi l'auto-construction et l'auto-ravitaillement sans toucher aux activations par planète.

### Modules
| Fichier | Rôle |
|---|---|
| `core.ts` | Client, flags, log/notification, santé, `prepareFleet`/`sendFleet`, helpers |
| `threats.ts` | Parsing de `menaces`/`incoming`/`alertesVives` (format du bundle) |
| `bot.ts` | Boucle de poll, fleet-save par planète, collect, capture de données, résumés |
| `tips.ts` | `/tips` : index court des commandes et fiche détaillée par commande (flottes des presets lues dans `PRESETS`) |
| `presets.ts` | Raids `/p0` `/p1` `/p2` `/p3` (validation de la cible dans la galaxie) |
| `scan.ts` | Planètes d'un joueur (leaderboard + galaxie, cache 30 min), scans `/scan_<joueur>` |
| `expedition.ts` | `/explo opti`, `/explo 911` et l'expédition permanente (`/autoexplo`) |
| `notify.ts` | Événements entre deux polls (bâtiment / recherche / chantier terminés, sondage subi, impact) — ids persistés dans `seen.json` |
| `autobuild.ts` | Auto-construction pilotée par `build-plan.json` (migration du plan, « besoin » de chaque planète) |
| `buildfund.ts` | Bâtiments des colonies financés par Père (`/autobuild finance`), commandes persistées dans `build-fund.json` |
| `autofleet.ts` | Flotte automatique (`/autofleet`) : plancher et surplus de Père, lots, réglages dans `auto-fleet.json` |
| `reserve.ts` | Réservation d'une planète (`/fleetbuild` livré, financement en cours) : un seul test pour tous les automatismes |
| `nextbuild.ts` | `/next` : construction et recherche mises en attente, retenue de la recherche, Graviton automatique |
| `supply.ts` | Auto-ravitaillement par colonie depuis Père (`/autosupply`), échéances persistées dans `supply.json` |
| `deut.ts` | Plafond de deut des colonies (`/autodeut`) : l'excédent repart vers Père, calcul pur `planDeutAuto` |
| `fleetbuild.ts` | `/fleetbuild` : vaisseaux construits sur le chantier d'une colonie, ressources envoyées par Père, commandes persistées dans `fleet-build.json` |
| `pirates.ts` | Veille des caches pirates (Telegram + Discord) |
| `salvage.ts` | Débris (recycleurs) et cargaisons (éclaireurs) |
| `discord.ts` | Webhook Discord (alertes pirates uniquement) |

### 1. Fleet-save (par planète, multi-vagues) — sondes ET attaques
- **Aucun vaisseau sur place** → alerte explicite (« impact dans X mais AUCUN vaisseau — rien à faire décoller ») et pas de faux message de rappel derrière [corrigé 22/09, vu sur BetweenLands].
- **Carburant** : si le serveur refuse avec `Deutérium insuffisant : N nécessaires`, le bot relance une fois en laissant `N × 1,2` de deutérium sur place et le dit.
- Poll `/state` toutes les 10 s (± 20 % de jitter, réglable `POLL_MS`). **Jamais de poll rapide** (soupçons) : quand une échéance approche (décollage à `arrivesAt − SAVE_BEFORE_MS`, rappel à `recallAt`), la boucle dort jusqu'à l'échéance exacte puis fait un seul appel. Tous les timings utilisent `now` (horloge serveur).
- Format des menaces lu dans le bundle [BUNDLE, jamais vu en live] : `menaces[] = { fleetId, mission, attaquant, cible: { nom, coords }, arrivesAt }`.
  Le brut est loggé (`incoming-samples.jsonl`) **et notifié** dès qu'il change.
- **Déclencheurs du save** (décision du 21/09) : `espionage` **et** toute attaque (tout sauf `destroyMoon`). Décollage **10 s** avant l'impact (`SAVE_BEFORE_MS = 10000`).
  Les sondes du même système arrivent en ~130 ms : impossible à contrer, le save vise surtout les sondes lointaines et les attaques.
- **Groupement par planète cible** : `saveAt = min(arrivesAt) − 10 s`, `recallAt = max(arrivesAt) + 1,5 s`.
  Décollage à `saveAt` si la menace existe encore (attaquant qui rappelle avant → on ne bouge pas ; menace vue à moins de 10 s → on décolle quand même).
  Une nouvelle vague pendant le save **repousse le rappel** au lieu de relancer un save.
- Décollage : tous les vaisseaux (sauf satellites) en `deploy` vers la planète la plus proche **non attaquée** si possible,
  sinon la plus proche quand même (être en vol suffit). Cargo rempli deut > cristal > métal en gardant `DEUT_RESERVE`.
- Rappel à `recallAt`. Si le rappel échoue ou la flotte s'est déjà posée, elle reste à l'abri sur la destination → `/deploy` pour la ramener.
- Pas de slot libre → pas de décollage, alerte claire. Pas de slot réservé (décision : on en a assez).
- **Hors périmètre** : missiles, lunes/`destroyMoon`.

### 2. Ravitaillement (`/supply`) — manuel, depuis Père
`/supply fils 40 14 90` → 40 000 métal, 14 000 cristal, 90 000 deut vers Fils (quantités en milliers ; `40k`, `1m`, ou brut ≥ 1000).
- **PT d'abord** (22 000 de vitesse) dans une flotte à part, **GT en complément** dans une 2e flotte (dans une même flotte tout vole à la vitesse du plus lent). Un seul slot libre → envoi mixte avec avertissement.
- Plafonné **uniquement** aux stocks de Père (garde `DEUT_RESERVE`) : pas de limite liée à la capacité de la planète de destination. Part immédiatement, récap ✅ par flotte.
- **Auto-ravitaillement** (`supply.ts`) : activé **par colonie** avec `/autosupply <planète> on|off` (alias `/supply_auto`), tout est désactivé par défaut. `/autosupply <planète>` donne l'état (prochain passage, manque, ce qui partirait), `/autosupply` celui de toutes les colonies, `/autosupply off` désactive tout.
  Une vérification toutes les **12 h** par colonie active (`SUPPLY_EVERY_H`) ; activer une colonie la rend due tout de suite (1er passage dans la minute). Activations et dernières vérifications sont persistées dans `supply.json` : un redémarrage ne relance pas de passage avant l'échéance.
  À chaque passage, cible **500 000 métal / 350 000 cristal / 150 000 deut** (`SUPPLY_TARGET_METAL`, `SUPPLY_TARGET_CRYSTAL`, `SUPPLY_TARGET_DEUT` dans `.env` ; surcharge par planète possible via `SUPPLY` dans supply.ts).
  Si le manque total atteint `SUPPLY_MIN_SEND` (20 000), Père envoie le complément arrondi au millier, GT d'abord puis PT en complément dans la même flotte ; alerte `📦 SUPPLY` avec l'heure du prochain passage.
  Limité au stock de Père (garde `DEUT_RESERVE`), sans plafond lié à la capacité de la destination. L'échéance est consommée quand la vérification aboutit (envoi parti, ou rien à envoyer — y compris Père trop pauvre).
  Elle ne l'est pas, et on réessaie chaque minute, si Père ou la colonie est menacée, si un transport est déjà en route vers la colonie, ou s'il n'y a ni transporteur à quai ni slot libre.
  Envoi refusé par le jeu (carburant, etc.) → une alerte `📦 SUPPLY KO`, nouvel essai vers cette colonie 15 min plus tard ; les autres colonies sont servies quand même. `/pause` suspend tout, les échéances restent intactes.
  Sur une colonie active, la collecte (section 3) ne la redescend pas sous sa cible (pas d'aller-retour).
- **Deut → Père** (`deut.ts`, `/autodeut on|off`, alias `/deut_auto`, flag `deut`, désactivé par défaut) : aucune colonie ne garde plus de **150 000 deut** (`DEUT_CAP`). Une évaluation par minute ; l'excédent part vers Père avec les transporteurs **sur la colonie** (GT puis PT, une seule flotte, deut seul), pourvu qu'il atteigne `DEUT_COLLECT_MIN` (10 000). Le carburant est pris sur les 150 000 qui restent.
  Rien si Père ou la colonie est menacée, si la colonie est réservée (`/fleetbuild`, financement de bâtiment) ou si un transport en part déjà vers Père. Aucun transporteur sur place → une alerte `⛽` par colonie (pas d'envoi) ; envoi refusé → alerte `⛽ DEUT KO`, nouvel essai 15 min plus tard. `/autodeut` seul donne l'état. Avec le flag actif, la cible de deut de l'auto-ravitaillement est plafonnée à `DEUT_CAP`.

### 3. Collecte (`collect`) — colonies → Père
BetweenLands déborde (90 k métal pour 6 k de capacité). Toutes les 60 s, si une ressource dépasse `COLLECT_THRESHOLD` (90 %)
de la capacité, le surplus au-dessus de `COLLECT_KEEP` (50 %) part vers Père avec les transporteurs sur place (GT puis PT).
Jamais depuis/vers une planète menacée ni depuis une planète réservée (`/fleetbuild`, financement de bâtiment), pas de doublon.

### 4. Raids (`/p0`, `/p1`, `/p2`, `/p3`) — toujours depuis Père, « attendre l'allié » ✔ (`rallier: true`)
| Commande | Composition |
|---|---|
| `/p0 under <sys:pos>` | 7 croiseurs + 10 GT |
| `/p0 over <sys:pos>` | 9 croiseurs + 10 GT |
| `/p0 opti_under <sys:pos>` | 11 éclaireurs |
| `/p0 opti_over <sys:pos>` | 13 éclaireurs |
| `/p1 under <sys:pos>` | 30 croiseurs + 30 GT |
| `/p1 over <sys:pos>` | 50 croiseurs + 30 GT |
| `/p1 trio <sys:pos>` | 50 croiseurs + 30 GT |
| `/p1 opti_under <sys:pos>` | 10 croiseurs + 32 éclaireurs |
| `/p1 opti_over <sys:pos>` | 20 croiseurs + 32 éclaireurs |
| `/p1 opti_trio <sys:pos>` | 5 croiseurs + 32 éclaireurs (la 2e ligne « trio » de la spec) |
| `/p2 trio <sys:pos>` | 110 croiseurs + 40 GT + 10 éclaireurs + 2 VB |
| `/p2 under <sys:pos>` | 140 croiseurs + 50 GT + 50 éclaireurs |
| `/p2 over <sys:pos>` | 160 croiseurs + 50 GT + 50 éclaireurs |
| `/p3 <sys:pos>` (ou `/p3 tout <sys:pos>`) | **dynamique** : jusqu'à 150 GT + tous les croiseurs, éclaireurs, VB et traqueurs à quai sur Père |

`/p3` (caches T3) calcule la flotte au moment de la commande d'après ce qui est à quai sur Père ; les vaisseaux lents (bombardiers, destructeurs, recycleurs…) restent à quai.
Moins de 150 GT → ligne `⚠️ seulement N GT à quai (150 visés)` dans le récap ; aucun vaisseau de combat à quai → refus, pas d'attaque.
Quand un groupe n'a qu'une variante, elle est facultative dans la commande.

Avant la confirmation, la cible est vérifiée par `GET /galaxy?system=N` : position 1–15, planète présente, pas à nous ;
sinon « Aucune planète en X:Y » et pas d'attaque. Le récap affiche le nom de la planète et son propriétaire.

### 4b. Veille des caches pirates (`pirates.ts`)
- Toutes les 5 min (`PIRATE_CHECK_MS`) : un seul `GET /galaxy/carte` ; si le nombre de pirates d'un système change, lecture de ce système.
- Notification 🏴‍☠️ à chaque nouvelle cache : nom, tier, position, expiration, échelon maîtrisé ou non, et le preset conseillé (T0 → `/p0`, T1 → `/p1`, T2 → `/p2`, T3 → `/p3`). Liste complète au démarrage et via `/pirates` ; `/pirates p1|p2|p3` (plusieurs possibles, `t1` accepté) n'affiche que ce niveau, sans appel réseau supplémentaire.
- **Discord** : chaque nouvelle cache est aussi postée sur un webhook de salon (`DISCORD_WEBHOOK_URL`, `discord.ts`) — pas de bot Discord, juste un POST. Rien d'autre n'y transite.
- Les presets acceptent une cache pirate ou un convoi comme cible (le récap le dit, et avertit si le tier ne correspond pas au preset).

### 4c. Récupération automatique (`salvage.ts`)
Relevé toutes les 10 min (`SALVAGE_CHECK_MS`) : un `GET /galaxy/carte` (champs `debris` / `cargaison` par système), puis lecture des seuls systèmes concernés.
- **Débris** (`/recycle on`) : mission `recycle` avec `coords.body = "debris"` [BUNDLE], **2 recycleurs** (`RECYCLERS_PER_FIELD`) dès que métal + cristal ≥ **40 000** (`DEBRIS_MIN`). Toute la galaxie, sans limite de distance.
- **Cargaisons abandonnées** (`/recup on`) : mission `recuperation`, flotte **dimensionnée sur le volume annoncé** — 1 éclaireur (soute 10 000) par tranche de 10 000, ex. 40 000 → 4 éclaireurs, plafonné à `RECUP_MAX_PATHFINDER` (50). `RECUP_MARGIN` (1 par défaut) ajoute une marge, `RECUP_SMALL_CARGO` (0) des PT en plus. Respecte le quota journalier (`sys.recup.restantes` / `plafond`) et saute la cible si elle s'éteint (`expireA`) avant l'arrivée estimée.
- Départ depuis la planète **la plus proche** qui possède les vaisseaux ; si la flotte n'est pas disponible ou qu'aucun slot n'est libre, **on n'envoie rien** (log, pas d'alerte). Pas de doublon : une cible déjà en route ou traitée dans l'heure est ignorée.
- `/salvage` liste ce que le bot voit (débris, cargaisons, quota) sans rien envoyer.

### 5. Scans (`/scan_<joueur>`, `/scan <joueur>`)
15 sondes (`SCAN_PROBES`) depuis Père sur **chaque** planète du joueur, une flotte par planète, envoyées en même temps, **immédiatement** (pas de confirmation) ; récap ✅/❌ par planète.
Pas assez de sondes → `floor(dispo / nb planètes)` par planète. Pas assez de slots → seules les N premières planètes.
Les planètes du joueur viennent du relevé `galaxy-snapshot.json` (systèmes à vérifier) puis de `/galaxy?system=N` (cache 30 min) ;
si le compte diffère du classement, parcours complet. Raccourcis prévus : `/scan_2003CP0`, `/scan_987`, `/scan_Thomas`, `/scan_aaa` (tout nom marche).

### 6. Expéditions (`/explo`)
Cible : position `state.expedition.position` (16) du système de Père, mission `expedition`, `holdHours = min(h, maxHours)` (durée d'exploration ; `heures` est la garde sur balise).
Refus clair si aucun slot d'expédition, quota 24 h atteint ou système saturé (`saturatedSystems`).
- `/explo opti <h>` : 10 éclaireurs + 100 GT.
- `/explo 911 [h]` (2 h par défaut) : tous les éclaireurs + GT + vaisseaux de bataille + croiseurs de Père, **toutes les ressources** embarquables
  (deut > cristal > métal) en gardant **≥ 80 000 deutérium** sur Père (`EXPLO_DEUT_KEEP`). `h` par défaut = `maxHours`.
- **Expédition permanente** (`/autoexplo on|off`, alias `/explo_auto`, flag `explo`, désactivé par défaut) : le bot garde toujours **deux** expéditions opti en vol (`EXPLO_AUTO_COUNT`, 10 éclaireurs + 100 GT chacune, **6 h**, `EXPLO_AUTO_HOURS`).
  Une évaluation par minute, un envoi à la fois (5 min d'écart) ; une expédition part dès qu'il y en a moins de deux en vol ou pas encore rentrées (flottes `expedition` de `fleets`, `inFlight`) et que Père n'est pas menacée. `/autoexplo` seul donne l'état (en vol, retour, quota du jour, blocage).
  Quota 24 h, slot ou vaisseaux manquants : aucun envoi, une alerte `🧭 Expédition auto en attente` par raison, nouvel essai à la minute. Envoi refusé : alerte `🧭 Expédition auto KO`, nouvel essai 15 min plus tard ; 5 min de garde après un envoi réussi. `/pause` la coupe.

### 7. Notifications
Formats confirmés en live le 22/09 (`menaces`, `alertesVives`, `reports`, `arrivalReports`) : plus aucun JSON brut n'est envoyé sur Telegram.
- `🚨 ATTAQUE de 2003CP0 — 36 vaisseaux (25 croiseurs, 11 GT) depuis 17:7 → BetweenLands (17:6) · impact dans 5 min 20` (idem `🔍 SONDAGE`)
- `🔍 2003CP0 a sondé BetweenLands (17:6) : 5 sondes envoyées, 0 repérées` (`alertesVives`)
- `💥 Raid de 2003CP0 sur BetweenLands : pillé … · pertes défense : … · survivants attaquant : …` (rapport de combat subi)
- `☠ Raid pirate T1 en 3:5 : butin … · pertes … · repaire détruit ✅ · avec Pirate` et `🏆 Trésor pirate : rang 1 · gain …`
- `🛬 Retour sur Planète Père : 13 éclaireurs, 10 GT · 108 572 M · 54 286 C · 21 715 D`
- Un élément au format inattendu est envoyé en brut **une seule fois** (pour correction), pas à chaque poll.
- 🚨/🔍 menace en approche (attaque / sondage), 💥 impact.
- 🏗 bâtiment terminé (planète + nom), 🔬 recherche terminée, 🚀 lot de chantier terminé.
- 🔍 sondage subi (nouveau `spyReports[]` avec `role: "defender"`), 📜 rapport d'un genre encore inconnu (brut).
- `[OBSERVATION]` : ce que le bot ferait si les flags étaient armés. ❌ erreurs (1 fois, puis toutes les 15 min max). 💓 heartbeat, 🚨 poll bloqué.
Les ids déjà notifiés sont dans `seen.json` (pas de doublon après un restart pm2).

### 8. Auto-construction — objectifs (règles du 22/09/2026, revues le 05/10/2026)
Ordre appliqué **par planète**, chaque bâtiment jusqu'à son objectif :

| Ordre | Bâtiment | Objectif |
|---|---|---|
| 1 | Laboratoire de recherche | 10 (Père : 12, pour Graviton) |
| 2 | Usine de nanites | 4 |
| 3 | Fabrique de robots | 12 |
| 4 | Chantier spatial | 8 |
| 5 | Mine de métal | 20 |
| 6 | Mine de cristal | 20 |
| 7 | Synthétiseur de deutérium | 20 |
| 8 | Silo de missiles | 5 |

**Plafonds par planète** : `"plafonds": { "researchLab": 12 }` dans l'entrée d'une planète de `build-plan.json` remplace le max de cette clé
sans recopier la liste (une clé absente de la liste est ajoutée à la fin). `/plan` affiche les plafonds qui diffèrent des défauts.
**Migration** : `build-plan.json` n'est jamais copié par `/maj` ; au chargement, un plan sans `defaults.version` (ou d'une version
antérieure) reçoit les nouveaux objectifs, le plafond labo 12 sur Père, `financement: true` et `graviton: true`, en conservant
tout le reste (activations, `energyFirst` de BetweenLands, `graceMs`…), puis est réécrit. Idempotent ; une alerte 🏗 le signale.

Règles transverses, dans l'ordre de décision :
- **Énergie déjà négative** : une centrale (`energyFirst` de la planète) avant tout le reste.
- **Ressources insuffisantes → on passe au suivant** de la liste (jamais d'attente bloquante). Le premier candidat écarté **uniquement**
  pour manque de ressources (centrale si énergie négative, puis objectifs avec leurs substituts réservoir / centrale) est le **besoin**
  de la planète : c'est lui que Père finance (8d). Pas de saut vers un objectif moins cher plus bas pour le financement.
- **Réservoir plein** (≥ 98 % de la capacité, la production se perd) : avant d'améliorer la mine concernée, on agrandit `metalStorage` / `crystalStorage` / `deuteriumStorage`.
- **Énergie** : si une amélioration ferait passer le solde en négatif, on construit d'abord une **centrale de fusion**, à défaut une **centrale solaire** (BetweenLands : solaire uniquement, la fusion n'y existe pas). Si aucune centrale n'est finançable, l'amélioration est écartée (et la centrale devient le besoin) — on ne laisse jamais l'énergie plonger.
- **En dernier**, objectifs tous traités : réservoir ≥ 98 % alors que sa mine est **au plafond** → on l'agrandit, payé par le stock local uniquement (jamais un besoin financé par Père).

Contraintes du jeu prises en compte : le **laboratoire** est intouchable pendant une recherche, le **chantier** pendant une production (`shipyardBusy`). Un bâtiment refusé par le jeu est écarté 30 min avec un seul message.
Quand tous les objectifs d'une planète sont atteints, le bot **s'arrête** sur cette planète (`/plan` l'affiche) — les niveaux supérieurs restent à ta main via `/next`.

### 8b. `/next` — enchaîner une construction sans attendre
Un ordre **par planète**, persisté dans `next-build.json` (survit aux redémarrages), lancé **dès que la file se libère** : ni délai de grâce, ni priorités, ni flag — c'est un ordre manuel, prévu pour que la nuit ne soit pas perdue.
- `/next` → liste des planètes en boutons (file en cours, ⏭ si un ordre attend) puis liste des bâtiments (niveau, coût, durée).
- `/next <planète>` → directement la liste des bâtiments · `/next <planète> <key>` → mise en attente immédiate · `/next <planète> off` → annulation.
- `/next <planète> labo` → liste des recherches (bouton 🔬 également en tête de la liste des bâtiments d'une planète) · `/next <planète> labo <key>` → mise en attente · `/next labo off` → annulation. Une seule recherche à la fois (contrainte du jeu), lancée depuis le labo de **la planète choisie** ; un avertissement s'affiche si une autre planète a un meilleur laboratoire. Sans planète, `/next labo` utilise le meilleur labo.
- `/nexts` → ce qui est en attente : recherche + chaque planète.
- Ressources manquantes ou refus du jeu : l'ordre **reste en attente**, réessai chaque minute, un seul message d'alerte par motif.
- Passe avant l'auto-construction : tant qu'un ordre `/next` attend, les priorités par paliers ne s'appliquent pas sur cette planète.
- **Labos d'abord** : une recherche en attente n'est pas lancée tant qu'une planète à autobuild activé n'a pas atteint son objectif `researchLab`
  (sinon la recherche repart aussitôt et rebloque le labo pour des jours). Alerte au début de la retenue ; au plus 12 h après la libération
  de la file de recherche, la retenue est levée avec une alerte. `/nexts` l'affiche.
- **Graviton automatique** (`/autobuild graviton on|off`, allumé par défaut, réglage `defaults.graviton`) : quand aucune recherche n'est en
  cours, que `player.research.graviton` vaut 0 et que `graviton` apparaît dans les options de recherche sans être verrouillé, le bot lance
  `POST /research { planetId: Père, key: "graviton" }`, avant la recherche en attente. Refus du jeu : une alerte par raison, nouvel essai au plus
  toutes les 10 min. Une fois lancée : alerte, puis on n'y revient plus (`gravitonAt` dans `next-build.json`). La clé `graviton` et son
  apparition dans `researchOptions` avec le labo 12 sont [DÉDUIT] du codex (prérequis : labo 12 ; ouvre l'étoile de la mort) ; son coût
  est inconnu tant qu'elle est verrouillée, un prérequis d'énergie comme dans OGame est possible [HYPOTHÈSE].

### 8c. `/fleetbuild` — construire des vaisseaux en colonie, payés par Père
Pour répartir la production sur les chantiers des colonies. Père paie, la planète choisie construit.
- `/fleetbuild` → boutons : planète (niveau du chantier) → vaisseau (options **débloquées sur cette planète**, coût et durée par unité) → quantité (1, 5, 10, 20, 50, 100, 200 selon ce qui est possible, et **max** = ce que Père peut financer ET transporter). Après le clavier des quantités, un nombre tapé seul est pris comme quantité (5 min ; une commande `/…` annule la saisie).
- `/fleetbuild <planète> <vaisseau> <qté|max>` → directement au récap. Vaisseau par clé API (`cruiser`) ou nom (`croiseurs`, `gt`, `pt`, `vb`, `éclaireur`, `traqueur`, `sonde`, `recycleur`…, casse et accents libres). `/fleetbuild <planète> [<vaisseau>]` ouvre la liste à l'étape suivante.
- Récap ✅/❌ : N × vaisseau, coût total, durée estimée (N × durée unitaire), transport prévu, ce qui reste sur Père.
- Confirmé : Père envoie le **coût total exact** (sans déduire le stock déjà présent sur la colonie) en **une** flotte transport, GT d'abord puis PT, `DEUT_RESERVE` gardé. Tout ou rien : pas de réduction de cargaison. Cible = Père : pas de transport, `POST /ships` immédiat.
- Refus clairs **avant tout envoi** : vaisseau verrouillé, pas de chantier, Père trop pauvre (avec le max finançable), transporteurs insuffisants (avec combien il en faut), aucun slot.
- Commande persistée dans `fleet-build.json` (n°, planète, vaisseau, quantité, coût, id de flotte, `arrivesAt`, état). Tick à chaque poll, avant la collecte, `/next` et l'auto-construction : à l'arrivée (`arrivesAt` serveur ; à défaut, flotte plus en phase aller), si le stock de la planète couvre le coût → `POST /ships`, alerte `🚀 <planète> : N <vaisseau> en construction`, commande retirée.
- Stock insuffisant (crédit pas encore visible, ressources dépensées, flotte rappelée) ou refus du jeu : la commande reste, au plus un POST par minute, une alerte par raison, **aucun abandon automatique**.
- **Réservation** : entre l'arrivée et le lancement, l'auto-construction, `/next` (bâtiment et recherche lancée depuis cette planète), la collecte, l'autodeut, l'autosupply et la flotte auto ne touchent pas à la planète. Pendant le vol, aucune réservation. `/pause` ne suspend pas ces commandes.
- `/fleetbuild liste` → commandes en cours et leur état · `/fleetbuild annule <n°>` → retire la commande (le transport n'est **pas** rappelé : `/recall <fleetId>`).

### 8d. Financement des bâtiments des colonies par Père (`buildfund.ts`)
`/autobuild finance on|off` — **allumé par défaut** (`defaults.financement` dans `build-plan.json`). Pour chaque colonie à autobuild activé qui a
un besoin (section 8), une commande au plus (jamais pour Père, qui paie sur place), persistée dans `build-fund.json` :
- Père envoie le **manque** (coût − stock de la colonie, par ressource, recalculé à chaque voyage sur le stock réel), en un ou plusieurs
  voyages : GT puis PT à quai sur Père, stock de Père moins `DEUT_RESERVE`, un slot libre (pas de slot réservé, comme le reste du bot).
  Un seul transport en vol par commande ; le suivant part dès l'arrivée du précédent (2 min de délai pour le crédit).
- Dès que le stock couvre le coût **actuel** (relu dans `buildOptions`) et que la file est libre : `POST /build`, alerte, commande retirée.
- **Réservation** : dès qu'une commande existe (en route ou livrée), ni autobuild, ni `/next`, ni collecte, ni autodeut, ni autosupply, ni flotte auto
  ne touchent à la colonie (`reserve.ts`, qui couvre aussi `/fleetbuild`).
- Besoin disparu (niveau atteint, bâtiment lancé à la main, autobuild désactivé, plafond abaissé) : commande retirée avec alerte, ressources
  laissées sur place. Refus du jeu : nouvel essai chaque minute, une alerte par raison, jamais d'abandon silencieux.
- Garde-fou : si le double du manque initial a été livré sans le combler (stock plafonné par la capacité ?), plus de voyage, alerte.
  Le dépassement de capacité par livraison est [DÉDUIT] de l'état du 05/10/2026 (Père à 6,4 M de cristal pour 6,1 M de capacité).
- Rien vers une colonie menacée ni depuis Père menacé. `/pause` suspend tout. `off` : plus de nouvelle commande, celles en cours vont au bout.
- `/autobuild finance` → état · `/autobuild finance annule <planète>` → retire la commande (transport non rappelé). Le détail est aussi dans `/plan`.

### 8e. Flotte automatique (`/autofleet`, `autofleet.ts`)
Un type de vaisseau par planète, **activé par défaut** sur les 5 (réglages dans `auto-fleet.json`, créé au premier chargement) :
BetweenLands GT · Cousin croiseurs · Fils destructeurs · Oncle éclaireurs · Père VB, sans limite (`max` = nombre total visé à quai).
- **Plancher de Père**, par ressource : le max, sur les planètes à autobuild activé, du coût de leur besoin (prochain objectif non atteint pour
  Père) ; plus Graviton s'il est visible et pas lancé (Graviton auto allumé) ; plus `DEUT_RESERVE` sur le deut. **Surplus** = stock − plancher.
- Rien tant qu'un financement de bâtiment (8d) attend encore des ressources de Père : les bâtiments d'abord.
- Une décision toutes les 5 min (`AUTOFLEET_EVERY_MIN`), **un lot** par décision, pour la planète activée au chantier libre (pas de file, pas
  `shipyardBusy`, pas de commande `/fleetbuild`, pas réservée, chantier pas en amélioration, pas menacée) servie le moins récemment.
- Lot limité par le surplus, la soute à quai sur Père (hors Père), le `max`, et ~2 h de chantier (`AUTOFLEET_LOT_H`) pour que le chantier se
  libère et puisse être amélioré ; pas de micro-lot sous 30 min de chantier (`AUTOFLEET_MIN_LOT_MIN`) sauf si le `max` le limite.
- Lancement par `planFleetBuild` / `startFleetBuild` (transport depuis Père, lancement à l'arrivée, visible dans `/fleetbuild liste` ; direct sur Père).
  Une alerte 🤖 par lot (planète, quantité, coût, surplus restant) ; erreur : une alerte par raison.
- `/autofleet` → résumé (par planète : type, on/off, à quai, en file, prochain lot ou blocage ; plancher et surplus de Père) ·
  `/autofleet <planète> on|off` · `/autofleet <planète> <vaisseau> [<n>|max]` (type, refusé s'il est verrouillé sur ce chantier ; `max` = illimité) ·
  `/autofleet <planète> max <n>|illimite`. Immédiat, sans confirmation. `/pause` suspend ; rien si Père est menacée.

### 9. Capture de données
- `incoming-samples.jsonl` : contenu brut de `incoming` / `menaces` / `alertesVives` dès qu'il change → **confirmer `parseThreats` au 1er échantillon**.
- `fleet-samples.jsonl` : chaque flotte vue (`ships`, `distance`, `fuel`, timings) → ajuster la formule de carburant et de distance.
- `post-samples.jsonl` : réponse de chaque POST (inconnues à ce jour).
- Latence de `GET /state` (moyenne glissante) dans `/status` et le heartbeat.

## Telegram

Long polling (aucun port ouvert). Seul `TG_CHAT_ID` est obéi ; `TG_CHAT_ID` vide → le bot répond « ton chat id est X » et n'exécute rien.

**Aide** : `/tips` liste toutes les commandes en une ligne chacune ; `/tips <commande>` (ex. `/tips pirates`, `/tips p1`, `/tips autosupply`) détaille ce que fait une commande, ses arguments et la flotte envoyée par un preset.

**Commandes courtes** (`/help`) : `/flotte` · `/joueur <nom>` · `/p0 …` · `/p1 …` · `/p2 …` · `/p3 …` · `/pirates [p1|p2|p3]` · `/scan_<joueur>` · `/explo …` · `/autoexplo …` · `/plan` · `/batiments <planète>` ·
`/autobuild …` · `/autobuild finance …` · `/autobuild graviton …` · `/autofleet …` · `/autosupply …` · `/autodeut …` · `/fleetbuild …` · `/status` · `/threats` · `/recall <id>` · flags · `/token <refresh_token>` · `/maj`.

**Actions** (récapitulatif + ✅ Confirmer / ❌ Annuler, expire après 60 s ; les scans partent sans confirmation) — `/help full` :
```
/p0 · /p1 · /p2 <variante> <sys:pos> · /p3 <sys:pos>
/scan_<joueur> · /scan <joueur>
/explo opti <h> · /explo 911 [h]
/send <planète> <mission> <sys:pos|planète> <k=n,k=n> [m=… c=… d=… speed=…]
/transport <de> <vers> <metal> <crystal> <deut>        (GT puis PT calculés)
/deploy <de> <vers> <k=n,k=n>
/spy <de> <sys:pos> [nbSondes]
/build <planète> <key> · /research <planète> <key> · /ships <planète> <key> <qty>
/cancel build|ships|research <planète> · /efficiency <planète> <key> <percent>
/fleetbuild [<planète> [<vaisseau> <qté>|max]]            (boutons, ressources envoyées par Père)
/maj                                                       (mise à jour depuis GitHub, retour arrière auto)
```
**Immédiat** (sans confirmation) : `/recall <fleetId>` · `/token` · `/save on|off` · `/autoexplo [on|off]` · `/autosupply [<planète>] [on|off]` (alias `/supply_auto`) · `/autodeut [on|off]` (alias `/deut_auto`) · `/collect on|off` · `/autobuild on|off [planète]` · `/autobuild finance on|off|annule <planète>` · `/autobuild graviton on|off` · `/autofleet …` (alias `/flotte_auto`) · `/fleetbuild liste` · `/fleetbuild annule <n°>` · `/pause` · `/resume`

`<planète>` = nom (« Père »), id (`pl_2w`) ou coords (`6:4`).
**Heartbeat** toutes les `HEARTBEAT_H` h (uptime, latence, polls) ; alerte si aucun poll réussi depuis > 2 min.

## Soutes et formules

Soutes de base : PT 5 000 · GT 25 000 · éclaireur 10 000 · recycleur 20 000 · croiseur 800 · VB 1 500 · colonisateur 7 500 ·
chasseur léger 50 · chasseur lourd 100 · sonde 5.

- `durée_ms = ceil(4 800 000 × distance / vitesse_du_plus_lent)` à 100 % — [CALCULÉ] exact à la ms sur 2 flottes
- `distance = 2700 + 95 × |Δ systèmes|` (même galaxie) — [HYPOTHÈSE] 2 points seulement
- Vitesse = base × (1 + 0,1·combustion | 0,2·impulsion | 0,3·hyperespace) — [CALCULÉ] sur `player.vitesses` ; exception PT (22 000)
- Débris = 30 % métal+cristal des vaisseaux détruits
- Conséquence : même dans le même système (distance 2 700), une flotte d'attaque met plusieurs minutes → la marge de 5 s tient.
  Les sondes arrivent quasi instantanément mais ne pillent pas. [CALCULÉ sur formule HYPOTHÈSE]

## Sécurité et bon voisinage

- **Rien de sensible dans le dépôt** : jetons, `.env`, état d'exécution et relevés de galaxie sont ignorés par git.
  Les jetons sont masqués dans les logs.
- **Pas de sondage agressif de l'API** : un appel toutes les 10 s avec 20 % de variation aléatoire, jamais de rafale.
  Quand une échéance approche, le bot dort jusqu'à l'instant exact puis fait **un seul** appel.
- Les routes d'administration du jeu ne sont **jamais** appelées.
- Chaque action réelle déclenchée depuis Telegram demande une confirmation explicite.

## À vérifier / inconnues

1. Échange du ticket : `Location` (fragment ou query) ou `Set-Cookie` ? Format du `kaiya_session` (JWT ? segment du payload ?).
2. Header `x-kaiya-session` **ou** cookie suffit-il seul ?
3. Réponse JSON de chaque POST (dont l'id de flotte renvoyé par `/fleet`, utilisé pour le rappel).
4. Format de `incoming` / `menaces` / `alertesVives` (jamais vu non vide) ; présence du champ `mission`.
5. `/fleet/recall` jamais appelé en live ; le `deploy` est-il rappelable ?
6. Consommation de deut (formule carburant) → `DEUT_RESERVE = 5000` arbitraire. Données : `fleets[].distance` + `fuel`.
7. Effet de `speedPercent` < 100 ; 3e point pour la formule de distance.
8. Body d'une expédition (durée), rôle de `rallier` et de `/fleet/ralliement/lancer`.
9. Auto-ravitaillement : cibles par défaut (500 k / 350 k / 150 k) et période de 12 h à valider en conditions réelles ; surcharges par colonie via **`SUPPLY`** (supply.ts) si besoin.
10. Rotation du refresh token : l'ancien reste-t-il valide ? le `exp` glisse-t-il ?
11. Android 16 + Termux : bootstrap, `termux-wake-lock`, pm2 en arrière-plan.

