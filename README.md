# Space-K Bot

Bot d'automatisation pour **Space-K**, un jeu de stratégie spatiale de type OGame hébergé comme application interne.
Il parle à l'API du jeu, tourne **24/7 sur un vieux téléphone Android** (Termux) et se pilote **depuis Telegram**.

**Ce qu'il fait pour vous, sans intervention :**

- 🛡 **Fleet-save** — 10 s avant qu'une sonde ou une attaque ne touche une planète, toute la flotte décolle
  avec un maximum de ressources, puis rentre juste après le passage. L'attaquant trouve une planète vide.
- 🏗 **Auto-construction** — enchaîne les bâtiments selon une liste d'objectifs, planète par planète,
  en gérant l'énergie, les réservoirs pleins et les files occupées.
- ⏭ **`/next`** — met une construction ou une recherche en attente : elle part dès que la file se libère,
  y compris en pleine nuit.
- ☠ **Veille pirates** — annonce chaque nouvelle cache/repaire/bastion/citadelle avec le raid conseillé (Telegram + Discord).
- ♻️ **Récupération** — envoie des recycleurs sur les champs de débris et des éclaireurs sur les cargaisons abandonnées.
- 🔔 **Notifications** — bâtiment, recherche ou chantier terminés, sondage subi, attaque en approche, impact, rapports de combat, erreurs.

**Ce que vous déclenchez depuis Telegram :** raids sur presets, scans d'un joueur entier, expéditions,
ravitaillement entre planètes, constructions, recherches — chaque action réelle demande une confirmation ✅.

Toutes les actions automatiques sont **désarmées par défaut** : le bot annonce ce qu'il *aurait* fait
tant que vous ne l'avez pas armé (`/save on`, `/collect on`, `/autobuild <planète> on`…).

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
# Ensuite tout se pilote à distance :
scp *.ts *.json *.sh <user>@<ip-du-téléphone>:spacek-bot/    # port 8022
ssh <user>@<ip-du-téléphone> "cd spacek-bot && bash setup-termux.sh"
```

`setup-termux.sh` installe les dépendances, `pm2`, le script de démarrage automatique (Termux:Boot)
et crée un `.env` en mode observation. Ensuite :

```bash
pm2 start "npx tsx --env-file=.env telegram.ts" --name spacek && pm2 save
pm2 logs spacek
```

Points d'attention : exclure Termux de l'optimisation de batterie, garder `termux-wake-lock` actif,
et ne pas balayer l'application hors des récentes.

### 5. Discord (optionnel)

Salon → Intégrations → Webhooks → Nouveau webhook → copier l'URL dans `DISCORD_WEBHOOK_URL`.
Aucun bot Discord n'est nécessaire : le serveur reçoit un simple POST. **Seules les alertes pirates** y sont publiées.

## Configuration

| Fichier | Rôle |
|---|---|
| `.env` | Jetons, flags de départ, réglages (voir `.env.example`) — jamais commité |
| `build-plan.json` | Objectifs d'auto-construction, activation par planète — rechargé à chaud |
| `refresh_token.txt` | Jeton Keycloak, tourné automatiquement (`.bak` conservé) — jamais commité |
| `flags.json`, `next-build.json`, `seen.json` | État persistant du bot, écrit à l'exécution |

`HOME_PLANET` désigne la planète qui sert de hub (départ des raids, scans, expéditions et ravitaillements).
Les identifiants de planètes, clés de bâtiments et de vaisseaux viennent tous de `/api/state`.

## Structure du code

| Fichier | Rôle |
|---|---|
| `spacek-client.ts` | Client API : chaîne d'authentification complète, rotation atomique du jeton, retry 401, un wrapper par endpoint |
| `bot.ts` | Boucle de poll, fleet-save, ravitaillement, collecte, capture de données |
| `telegram.ts` | Commandes, confirmations, notifications, heartbeat |
| `setup-termux.sh` | Installation côté téléphone |
| `space-k-api.md` | Référence de l'API du jeu |

## Fonctionnalités

Tout démarre en **mode observation** : les flags `SAVE_ARMED`, `SUPPLY_ENABLED`, `COLLECT_ENABLED`, `AUTOBUILD_ENABLED` sont à `false`.
Le bot calcule, logue et notifie « j'AURAIS décollé / envoyé », mais n'émet aucun POST automatique.
Les flags se changent à chaud via Telegram (`/save on`, `/supply on`, `/collect on`, `/autobuild on`, `/pause`, `/resume`).

### Modules
| Fichier | Rôle |
|---|---|
| `core.ts` | Client, flags, log/notification, santé, `prepareFleet`/`sendFleet`, helpers |
| `threats.ts` | Parsing de `menaces`/`incoming`/`alertesVives` (format du bundle) |
| `bot.ts` | Boucle de poll, fleet-save par planète, supply, collect, capture de données, résumés |
| `presets.ts` | Raids `/p0` `/p1` (validation de la cible dans la galaxie) |
| `scan.ts` | Planètes d'un joueur (leaderboard + galaxie, cache 30 min), scans `/scan_<joueur>` |
| `expedition.ts` | `/explo opti` et `/explo 911` |
| `notify.ts` | Événements entre deux polls (bâtiment / recherche / chantier terminés, sondage subi, impact) — ids persistés dans `seen.json` |
| `autobuild.ts` | Auto-construction pilotée par `build-plan.json` |
| `nextbuild.ts` | `/next` : construction et recherche mises en attente |
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
- Le job automatique par seuils (`SUPPLY` dans bot.ts, flag `/supply_auto`) existe mais n'a pas de seuils configurés.

### 3. Collecte (`collect`) — colonies → Père
BetweenLands déborde (90 k métal pour 6 k de capacité). Toutes les 60 s, si une ressource dépasse `COLLECT_THRESHOLD` (90 %)
de la capacité, le surplus au-dessus de `COLLECT_KEEP` (50 %) part vers Père avec les transporteurs sur place (GT puis PT).
Jamais depuis/vers une planète menacée, pas de doublon.

### 4. Raids (`/p0`, `/p1`, `/p2`) — toujours depuis Père, « attendre l'allié » ✔ (`rallier: true`)
| Commande | Composition |
|---|---|
| `/p0 under <sys:pos>` | 7 croiseurs + 10 GT |
| `/p0 over <sys:pos>` | 9 croiseurs + 10 GT |
| `/p0 opti_under <sys:pos>` | 11 éclaireurs |
| `/p0 opti_over <sys:pos>` | 13 éclaireurs |
| `/p1 under <sys:pos>` | 60 croiseurs + 30 GT |
| `/p1 over <sys:pos>` | 70 croiseurs + 30 GT |
| `/p1 trio <sys:pos>` | 50 croiseurs + 30 GT |
| `/p1 opti_under <sys:pos>` | 20 croiseurs + 32 éclaireurs |
| `/p1 opti_over <sys:pos>` | 10 croiseurs + 32 éclaireurs |
| `/p1 opti_trio <sys:pos>` | 5 croiseurs + 32 éclaireurs (la 2e ligne « trio » de la spec) |

Avant la confirmation, la cible est vérifiée par `GET /galaxy?system=N` : position 1–15, planète présente, pas à nous ;
sinon « Aucune planète en X:Y » et pas d'attaque. Le récap affiche le nom de la planète et son propriétaire.

- `/p2 trio <sys:pos>` — 110 croiseurs + 40 GT + 10 éclaireurs + 2 VB
- `/p2 under <sys:pos>` — 110 croiseurs + 40 GT + 20 éclaireurs + 2 VB
- `/p2 over <sys:pos>` — 110 croiseurs + 40 GT + 30 éclaireurs + 10 VB

### 4b. Veille des caches pirates (`pirates.ts`)
- Toutes les 5 min (`PIRATE_CHECK_MS`) : un seul `GET /galaxy/carte` ; si le nombre de pirates d'un système change, lecture de ce système.
- Notification 🏴‍☠️ à chaque nouvelle cache : nom, tier, position, expiration, échelon maîtrisé ou non, et le preset conseillé (T0 → `/p0`, T1 → `/p1`, T2 → `/p2`). Liste complète au démarrage et via `/pirates`.
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
Cible : position `state.expedition.position` (16) du système de Père, mission `expedition`, `heures = min(h, maxHours)`.
Refus clair si aucun slot d'expédition, quota 24 h atteint ou système saturé (`saturatedSystems`).
- `/explo opti <h>` : 10 éclaireurs + 100 GT.
- `/explo 911 [h]` (2 h par défaut) : tous les éclaireurs + GT + vaisseaux de bataille + croiseurs de Père, **toutes les ressources** embarquables
  (deut > cristal > métal) en gardant **≥ 80 000 deutérium** sur Père (`EXPLO_DEUT_KEEP`). `h` par défaut = `maxHours`.

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

### 8. Auto-construction — objectifs (règles du 22/09/2026)
Ordre appliqué **par planète**, chaque bâtiment jusqu'à son objectif :

| Ordre | Bâtiment | Objectif |
|---|---|---|
| 1 | Fabrique de robots | 12 |
| 2 | Laboratoire de recherche | 10 |
| 3 | Chantier spatial | 8 |
| 4 | Mine de métal | 20 |
| 5 | Mine de cristal | 20 |
| 6 | Synthétiseur de deutérium | 20 |
| 7 | Silo de missiles | 5 |

Trois règles transverses :
- **Ressources insuffisantes → on passe au suivant** de la liste (jamais d'attente bloquante).
- **Réservoir plein** (≥ 98 % de la capacité, la production se perd) : avant d'améliorer la mine concernée, on agrandit `metalStorage` / `crystalStorage` / `deuteriumStorage`. Pas d'objectif de niveau : seulement quand c'est nécessaire.
- **Énergie** : si l'amélioration retenue ferait passer le solde en négatif, on construit d'abord une **centrale de fusion**, à défaut une **centrale solaire** (BetweenLands : solaire uniquement, la fusion n'y existe pas). Si aucune centrale n'est finançable, l'amélioration est écartée — on ne laisse jamais l'énergie plonger.

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

### 9. Capture de données
- `incoming-samples.jsonl` : contenu brut de `incoming` / `menaces` / `alertesVives` dès qu'il change → **confirmer `parseThreats` au 1er échantillon**.
- `fleet-samples.jsonl` : chaque flotte vue (`ships`, `distance`, `fuel`, timings) → ajuster la formule de carburant et de distance.
- `post-samples.jsonl` : réponse de chaque POST (inconnues à ce jour).
- Latence de `GET /state` (moyenne glissante) dans `/status` et le heartbeat.

## Telegram

Long polling (aucun port ouvert). Seul `TG_CHAT_ID` est obéi ; `TG_CHAT_ID` vide → le bot répond « ton chat id est X » et n'exécute rien.

**Commandes courtes** (`/help`) : `/flotte` · `/joueur <nom>` · `/p0 …` · `/p1 …` · `/scan_<joueur>` · `/explo …` · `/plan` · `/batiments <planète>` ·
`/autobuild …` · `/status` · `/threats` · `/recall <id>` · flags · `/token <refresh_token>`.

**Actions** (récapitulatif + ✅ Confirmer / ❌ Annuler, expire après 60 s ; les scans partent sans confirmation) — `/help full` :
```
/p0 <variante> <sys:pos> · /p1 <variante> <sys:pos>
/scan_<joueur> · /scan <joueur>
/explo opti <h> · /explo 911 [h]
/send <planète> <mission> <sys:pos|planète> <k=n,k=n> [m=… c=… d=… speed=…]
/transport <de> <vers> <metal> <crystal> <deut>        (GT puis PT calculés)
/deploy <de> <vers> <k=n,k=n>
/spy <de> <sys:pos> [nbSondes]
/build <planète> <key> · /research <planète> <key> · /ships <planète> <key> <qty>
/cancel build|ships|research <planète> · /efficiency <planète> <key> <percent>
```
**Immédiat** (sans confirmation) : `/recall <fleetId>` · `/token` · `/save on|off` · `/supply on|off` · `/collect on|off` · `/autobuild on|off [planète]` · `/pause` · `/resume`

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
9. Config manquante : composition **P1**, seuils **`SUPPLY`** par colonie.
10. Rotation du refresh token : l'ancien reste-t-il valide ? le `exp` glisse-t-il ?
11. Android 16 + Termux : bootstrap, `termux-wake-lock`, pm2 en arrière-plan.

