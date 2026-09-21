# Space-K Bot

Automatisation de **Space-K** (jeu de stratégie spatiale type OGame, app Kaiya `space-k.apps.kaiya.kreactive.fr`),
joueur **SylvainGsHunter**. Le bot tourne 24/7 sur un **Samsung Note 9** (Termux) et se pilote par **Telegram**.
Plus tard : mini API HTTP + app React via Tailscale.

Ce README est la **source de vérité** du projet (récap + décisions). La référence API détaillée est dans
[`space-k-api.md`](space-k-api.md).

## Règles de travail

- **Ne jamais inventer** une valeur, un endpoint ou un format. Si c'est inconnu, le dire.
- Distinguer **[TESTÉ]** (appelé en live) / **[BUNDLE]** (signature lue dans le code client) / **[DÉDUIT]** / **[HYPOTHÈSE]**.
- Ne **jamais** appeler `/api/dev/*` (routes admin).
- Toute action de jeu (flotte, construction…) = confirmation avant de la lancer, y compris en test.
- Tokens (`refresh_token.txt`, `.env`) : jamais commités, `chmod 600`. Voir `.gitignore`.

## Fichiers

| Fichier | Rôle |
|---|---|
| `spacek-client.ts` | Client : auth auto (refresh Keycloak + rotation atomique, ticket, session, retry 401) + un wrapper par endpoint |
| `bot.ts` + modules | Cœur (boucle, fleet-save, supply, collect) + `core.ts`, `threats.ts`, `presets.ts`, `scan.ts`, `expedition.ts`, `notify.ts`, `autobuild.ts` — voir « Modules ». CLI `watch` / `status` |
| `telegram.ts` | Point d'entrée serveur : `watch()` + commandes Telegram (lecture et actions avec confirmation) + notifications + heartbeat |
| `setup-termux.sh` | Installation sur le Note 9 (Termux, pm2, Termux:Boot) |
| `space-k-api.md` | Référence API (auth, endpoints, bodies, champs de `/state`, formules) |
| `.env.example` | Variables : `TG_TOKEN`, `TG_CHAT_ID`, flags, `HEARTBEAT_H`, `REFRESH_FILE`, `POLL_MS`, `SAVE_BEFORE_MS`, `SCAN_PROBES`, `EXPLO_DEUT_KEEP` |
| `build-plan.json` | Priorités d'auto-construction par planète (éditable à chaud) |
| `galaxy-snapshot.json` | Relevé complet de la galaxie du 21/09 (joueurs, planètes, débris) — cache initial des scans |

Fichiers de données produits par le bot (ignorés par git) : `incoming-samples.jsonl` (menaces brutes),
`fleet-samples.jsonl` (ships/distance/fuel pour les formules), `post-samples.jsonl` (réponses des POST), `seen.json` (ids notifiés).

## Auth (chaîne complète)

```
refresh_token Keycloak (168 h d'inactivité, localStorage kaiya.kreactive.fr, clé refresh_token)
  → POST https://auth.kreactive.fr/realms/PROD-Kaido/protocol/openid-connect/token
      grant_type=refresh_token, client_id=front-public-client (public, pas de secret)
      → access_token (5 min) + nouveau refresh_token (rotation : sauvegardé atomiquement)
  → POST https://kaiya.kreactive.fr/api/custom-apps/space-k/embed-ticket   (Bearer access_token)
      → 201 {"url": ".../__kaiya/session?ticket=…"}   [TESTÉ]
  → GET url du ticket → kaiya_session (~12 h)   [DÉDUIT : Location #kaiya_session= ? Set-Cookie ? — le client essaie tout et logue]
  → /api/* avec header x-kaiya-session + cookie kaiya_app_session   [TESTÉ]
```

- **Token dédié au bot** : copier le refresh token depuis une **fenêtre privée** (console → `copy(localStorage.refresh_token)`)
  puis fermer la fenêtre, pour que le navigateur habituel n'entre pas en concurrence sur la rotation.
- Le refresh token a 168 h d'**inactivité** : rafraîchi régulièrement par le bot, il devrait glisser indéfiniment
  (sauf SSO Session Max côté Keycloak) — à vérifier sur le `exp` renvoyé. [DÉDUIT]
- 401 = page HTML « Authentification requise », pas du JSON.

## Planètes

| Nom | id | Coords |
|---|---|---|
| Planète Père (hub, reçoit tout) | `pl_2w` | 6:4 |
| Planète Fils | `pl_rn` | 6:7 |
| Planète Oncle | `pl_402` | 6:2 |
| Planète Cousin | `pl_4z8` | 13:6 |
| BetweenLands | `pl_7vb` | 17:6 |

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
| `scan.ts` | Planètes d'un joueur (leaderboard + galaxie, cache 30 min, relevé `galaxy-snapshot.json`), scans `/scan_<joueur>` |
| `expedition.ts` | `/explo opti` et `/explo 911` |
| `notify.ts` | Événements entre deux polls (bâtiment / recherche / chantier terminés, sondage subi, impact) — ids persistés dans `seen.json` |
| `autobuild.ts` | Auto-construction pilotée par `build-plan.json` |

### 1. Fleet-save (par planète, multi-vagues) — sondes ET attaques
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

### 2. Approvisionnement (`supply`)
Toutes les 60 s, complète chaque colonie de `SUPPLY` jusqu'à ses seuils avec des GT depuis Père. Pas de doublon si un
transport est en route, plafonné à la capacité cible, **jamais vers une planète menacée**. `SUPPLY` est vide pour l'instant (seuils à fournir).

### 3. Collecte (`collect`) — colonies → Père
BetweenLands déborde (90 k métal pour 6 k de capacité). Toutes les 60 s, si une ressource dépasse `COLLECT_THRESHOLD` (90 %)
de la capacité, le surplus au-dessus de `COLLECT_KEEP` (50 %) part vers Père avec les transporteurs sur place (GT puis PT).
Jamais depuis/vers une planète menacée, pas de doublon.

### 4. Raids (`/p0`, `/p1`) — toujours depuis Père, « attendre l'allié » ✔ (`rallier: true`)
| Commande | Composition |
|---|---|
| `/p0 under <sys:pos>` | 7 croiseurs + 10 GT |
| `/p0 over <sys:pos>` | 9 croiseurs + 10 GT |
| `/p0 opti_under <sys:pos>` | 11 éclaireurs |
| `/p0 opti_over <sys:pos>` | 13 éclaireurs + 10 GT |
| `/p1 under <sys:pos>` | 60 croiseurs + 30 GT |
| `/p1 over <sys:pos>` | 70 croiseurs + 30 GT |
| `/p1 trio <sys:pos>` | 50 croiseurs + 30 GT |
| `/p1 opti_under <sys:pos>` | 20 croiseurs + 32 éclaireurs |
| `/p1 opti_over <sys:pos>` | 10 croiseurs + 32 éclaireurs |
| `/p1 opti_trio <sys:pos>` | 5 croiseurs + 32 éclaireurs (la 2e ligne « trio » de la spec) |

Avant la confirmation, la cible est vérifiée par `GET /galaxy?system=N` : position 1–15, planète présente, pas à nous ;
sinon « Aucune planète en X:Y » et pas d'attaque. Le récap affiche le nom de la planète et son propriétaire.

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
- 🚨/🔍 menace en approche (attaque / sondage), 💥 impact.
- 🏗 bâtiment terminé (planète + nom), 🔬 recherche terminée, 🚀 lot de chantier terminé.
- 🔍 sondage subi (nouveau `spyReports[]` avec `role: "defender"`), 📜 rapport d'un genre encore inconnu (brut).
- `[OBSERVATION]` : ce que le bot ferait si les flags étaient armés. ❌ erreurs (1 fois, puis toutes les 15 min max). 💓 heartbeat, 🚨 poll bloqué.
Les ids déjà notifiés sont dans `seen.json` (pas de doublon après un restart pm2).

### 8. Auto-construction (`autobuild`)
Fichier `build-plan.json` (rechargé à chaud dès qu'il change) :
```json
{ "pl_2w": { "enabled": false, "keepEnergyPositive": true, "skipUnaffordable": false,
             "priorities": [ { "key": "metalMine", "max": 25 }, { "key": "crystalMine", "max": 22 }, { "key": "solarPlant" } ] } }
```
Règle par planète activée (et flag global `autobuild` on) : si `buildQueue` est vide, prendre la **première** priorité dont le niveau
actuel est < `max` (absent = illimité), non verrouillée (`locked`/`missing`), dont le coût ≤ ressources, et qui ne fait pas passer
`energy.balance` en négatif (`keepEnergyPositive`). Si la première éligible n'est pas finançable, on **attend** (pas de saut vers une
priorité inférieure) sauf `skipUnaffordable: true`. Au plus une décision par planète par minute, un seul `POST /build` par tick.

Bâtiments (clés de `buildOptions`, 21/09) : `metalMine`, `crystalMine`, `deuteriumSynthesizer`, `solarPlant`, `fusionPlant`,
`metalStorage`, `crystalStorage`, `deuteriumStorage`, `robotFactory`, `shipyard`, `missileSilo`, `researchLab`.
Telegram : `/plan` (priorités + prochain bâtiment par planète, coût, finançable ?), `/batiments <planète>`, `/autobuild on|off`, `/autobuild <planète> on|off`.

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

## Serveur : Samsung Note 9

État au 21/09/2026 : **SM-N960F, LineageOS 23.2 (Android 16)**, Wi-Fi `192.168.1.155`, adb OK en USB.
Rien d'installé (pas de Termux, F-Droid ni Tailscale). Le téléphone reste branché chez toi, en Wi-Fi ; il n'est pas relié au Mac en permanence.

### Installation (par adb pendant qu'il est branché, puis ssh en Wi-Fi)
1. APK **Termux** (release GitHub `termux/termux-app`, même build que F-Droid — pas Play Store) + **Termux:Boot** + **Termux:API** → `adb install`.
2. Désactiver le *phantom process killer* (Android 12+) et exclure Termux de l'optimisation batterie (adb).
3. Dans Termux : `pkg install openssh && passwd && sshd` → ensuite tout se fait en `ssh -p 8022 <user>@192.168.1.155`.
4. Copier le projet dans `~/spacek-bot` (scp / git) + `refresh_token.txt` (`chmod 600`), puis `bash setup-termux.sh`.
5. Bot Telegram via @BotFather → `TG_TOKEN` dans `.env` → lancer une fois pour obtenir le chat id → `TG_CHAT_ID`.
6. `pm2 start "npx tsx --env-file=.env telegram.ts" --name spacek && pm2 save` · logs : `pm2 logs spacek`.
7. `termux-wake-lock`, Wi-Fi « toujours actif », relance au boot via `~/.termux/boot/start-spacek.sh`.
8. Batterie 24/7 sur un vieux téléphone : prise connectée avec timer (20–80 %) plutôt qu'une app root.
9. Plus tard : Tailscale pour l'accès hors du réseau local.

## Feuille de route

1. Valider l'auth de bout en bout en **lecture seule** (`npx tsx --env-file=.env bot.ts status`) → documenter l'échange ticket → session (§1.3) et la rotation du refresh token.
2. Fouiller le bundle client : format de `incoming`/`menaces`, éventuel push temps réel (`EventSource`/`WebSocket`), body d'expédition.
3. Déployer sur le Note 9 en **mode observation** ; laisser tourner quelques jours (menaces, fuel, latences).
4. Activer `collect` (BetweenLands), puis `supply` (seuils à définir), puis armer le fleet-save.
5. Presets d'attaque (`p1` à définir), puis couche HTTP + app React.

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

## Docs de jeu (locales)

- `~/Downloads/codex-space-k.md`
- `~/Downloads/knowlegde-base-main/sujets/space-k-arbre-technologique/index.html`
- Projet claude.ai : `moteur-combat.md`, `vaisseaux.md`, `defenses.md`, `Exemple attaque`, `Fonctionnement des combats`
  (6 rounds, tir simultané, ciblage aléatoire, tir rapide, seuil 1 % du bouclier, destruction > 70 % de la coque, pillage 50 % plafonné par la soute).
- Niveaux de recherche à jour : `player.research` dans `/state` (les fichiers datent du 12–15/09).

## Observations de jeu (21/09/2026)

- Mine de métal de Père réglée à **80 %** (énergie +444 depuis la centrale solaire 21).
- Aucun bâtiment en construction sur les 5 planètes au dernier relevé.
- BetweenLands déborde (90 k métal pour 6 000 de capacité), 50 petits transporteurs à quai.
- 2003CP0 a attaqué BetweenLands avec 5 `battlecruiser` et la re-sonde. Ses techs Armes/Bouclier/Protection sont à 8.
- Pacte actif avec Pirate.
