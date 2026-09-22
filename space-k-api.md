# Space-K — Référence API

> Relevé le **21/09/2026** sur `space-k.apps.kaiya.kreactive.fr` (client v1.75.0, bundle `index-crm0wJfE.js`).
> Légende : **[TESTÉ]** appelé en live avec succès · **[BUNDLE]** signature lue dans le code client, jamais appelée · **[DÉDUIT]** cohérent mais non vérifié.
> Les endpoints évoluent avec le jeu : si un appel casse, re-extraire depuis le bundle.

---

## 1. Authentification

Trois étages. Le bot n'a besoin que d'un **refresh token Keycloak** (≈ 7 jours) pour tout régénérer.

```
refresh_token Keycloak (7 j)
  └─► access_token Keycloak (5 min)
        └─► ticket d'embed Kaiya
              └─► kaiya_session (≈ 12 h) ──► /api/* Space-K
```

### 1.1 Keycloak → access_token [DÉDUIT : appel vu dans le Network, paramètres lus dans les tokens]
```
POST https://auth.kreactive.fr/realms/PROD-Kaido/protocol/openid-connect/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
client_id=front-public-client        # client public, pas de secret
refresh_token=<refresh_token>
```
- Le `refresh_token` initial se copie dans le **localStorage** de `kaiya.kreactive.fr`, clé `refresh_token`.
- Durées lues dans les tokens : access **5 min**, refresh **168 h**, type `Refresh` (pas `Offline`).
- Keycloak renvoie un nouveau `refresh_token` : **toujours le sauvegarder** (rotation).

### 1.2 Kaiya → ticket [TESTÉ]
```
POST https://kaiya.kreactive.fr/api/custom-apps/space-k/embed-ticket
Authorization: Bearer <access_token>
→ 201 {"url": "https://space-k.apps.kaiya.kreactive.fr/__kaiya/session?ticket=<ticket>"}
```

### 1.3 Ticket → kaiya_session [TESTÉ 21/09/2026 depuis le Note 9]
`GET <url du ticket>` (sans suivre la redirection) → **302** avec **les deux** :
```
Location: /#kaiya_session=<token>
Set-Cookie: kaiya_app_session=<token>; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=43200
```
Même token dans les deux. `Max-Age=43200` = 12 h confirmées. Serveur Express (`x-powered-by`).

### 1.4 Appels jeu [TESTÉ]
```
x-kaiya-session: <kaiya_session>
Cookie: kaiya_app_session=<kaiya_session>
Content-Type: application/json          # sur les POST
```
Les headers navigateur (`sec-*`, `user-agent`, `origin`…) sont inutiles. Reste à savoir si le header **ou** le cookie suffit seul.
Échec d'auth = **401 avec une page HTML** « Authentification requise » (pas du JSON).

Payload du `kaiya_session` (base64, lisible) : `sub` (player id), `orgId`, `slug`, `email`, `name`, `roles`, `exp`.

---

## 2. Conventions

- Lecture = `GET`, action = `POST` avec body JSON. [BUNDLE]
- Les ids de planète (`pl_2w`…) et les clés d'unités (`largeCargo`, `cruiser`…) viennent de `/api/state`.
- `coords` des envois : `{ system, position }`, **sans `galaxy`** (implicite, galaxie 1). [TESTÉ]
- **Réponses des POST** [TESTÉ 22/09] : tout POST qui réussit renvoie l'**état complet** du jeu (mêmes clés que `GET /state`) — il faut y retrouver soi-même ce qui a changé (ex. la flotte créée dans `fleets[]`). Une erreur renvoie un **400** avec `{ "error": "..." }`.
- Erreurs `POST /api/fleet` rencontrées : `{"error":"Deutérium insuffisant : 8836 nécessaires pour le trajet"}` (le carburant est prélevé **en plus** de la soute : laisser du deutérium sur la planète de départ).
- Erreur `POST /api/build` rencontrée : `{"error":"Une recherche est en cours : aucun laboratoire ne peut être modifié tant qu'elle tourne"}` (le `researchLab` est verrouillé tant que `player.researchQueue` n'est pas nul).

---

## 3. Lecture

| Méthode | Endpoint | Statut | Contenu |
|---|---|---|---|
| GET | `/api/state` | [TESTÉ] | **Tout** : joueur, recherches, 5 planètes, flottes en vol, `incoming`, `menaces`, rapports, contrats, échanges, pactes |
| GET | `/api/galaxy/carte` | [TESTÉ 21/09] | `{ systemes: [{ system, planetes, miennes, pirates, moissonneur, balise, depot, debris, cargaison }] }` — 40 systèmes, résumé seulement |
| GET | `/api/galaxy?system=N` | [TESTÉ 21/09] | `{ system, slots: [{ position, astroRequis, colonisable, pirate, balise, convoi, recup, contrat, planet: { id, name, ownerId, ownerName, temperature, vacances, protection, expose, ecart, moon } \| null, debris: { metal, crystal } \| null }], occupancy, recup }` |
| GET | `/api/leaderboard` | [TESTÉ 21/09] | `{ rows: [{ id, name, avatar, titre, combatPower, development, glory, total, planets }], meId }` |
| GET | `/api/codex?planetId=<id>` | [BUNDLE] | Codex (prérequis) |
| GET | `/api/profile/<playerId>` | [TESTÉ 21/09] | Par **id** (UUID du leaderboard), pas par nom (→ `{ error: "Joueur inconnu" }`). Renvoie `{ id, name, development, combatPower, planets (nombre), achievements, cadre, titre }` — pas les coordonnées |
| GET | `/api/rapport/<id>` | [BUNDLE] | Détail d'un rapport |
| GET | `/api/config` | [BUNDLE] | Config serveur |

### Champs utiles de `/api/state`
| Chemin | Usage |
|---|---|
| `now` | Horloge serveur (ms) — **toujours l'utiliser** plutôt que l'heure locale |
| `player.research` | Niveaux de recherche |
| `player.vitesses` | Vitesse effective par vaisseau |
| `player.isProtected`, `protectedUntil` | Protection débutant |
| `planets[].id / coords / resources / capacities / production / energy` | Économie par planète |
| `planets[].ships / defences / silo` | Forces à quai |
| `planets[].buildings` | `{ key: level }` — niveaux actuels des bâtiments [TESTÉ 21/09] |
| `planets[].energy` | `{ solar, fusion, satellite, produced, consumed, balance, fusionDeuterium, factor }` [TESTÉ 21/09] |
| `planets[].efficiency` | `{ metalMine, crystalMine, deuteriumSynthesizer, solarPlant, fusionPlant }` en % [TESTÉ 21/09] |
| `planets[].size / usedFields / temperature` | Champs de la planète [TESTÉ 21/09] |
| `planets[].buildQueue` | `{ key, targetLevel, cost, startedAt, finishesAt } \| null` [TESTÉ 21/09] |
| `planets[].shipQueue` | `{ kind: "ship"\|…, key, total, remaining, unitCost, unitMs, startedAt, nextAt, name } \| null` ; `shipQueueSuite[]` = lots suivants `{ kind, key, name, total, remaining, unitMs, rang }` ; `shipQueueFin` (ms) ; `shipyardBusy`, `labBusy` [TESTÉ 21/09] |
| `player.researchQueue` | `{ key, targetLevel, cost, planetId, startedAt, finishesAt } \| null` [TESTÉ 21/09] |
| `planets[].buildOptions[]` | `{ key, name, level (actuel), cost { metal, crystal, deuterium }, energyCost, durationMs, description, bonus, ouvre, locked, missing[], demolition }` — 12 clés : metalMine, crystalMine, deuteriumSynthesizer, solarPlant, fusionPlant, metalStorage, crystalStorage, deuteriumStorage, robotFactory, shipyard, missileSilo, researchLab [TESTÉ 21/09] |
| `planets[].shipOptions / defenceOptions` | Coûts et durées par unité |
| `researchOptions[]` (racine et par planète) | `{ key, name, level, cost, durationMs, description, ouvre, locked, missing[] }` [TESTÉ 21/09] |
| `planets[].nextBuildingUnlock / nextShipUnlock / nextDefenceUnlock` | Prochain déblocage `{ key, name, missing[], step { kind, key, name, level, where } }` [TESTÉ 21/09] |
| `fleets[]` | Flottes en vol : `id`, `mission`, `ships`, `phase`, `departsAt`, `arrivesAt`, `returnsAt`, `distance`, `fuel` |
| `fleetSlots` | `{ used, total }` [TESTÉ 21/09] |
| `expedition` | `{ level, unlocked, unlock, slots, inFlight, maxHours, position (16), maxPerSystemPer24h, maxPerPlayerPer24h, lanceesAujourdhui, heureDeReset, saturatedSystems[] }` [TESTÉ 21/09] |
| `joueurs[]` | `{ id, nom, libre }` — tous les joueurs (pour les pactes/échanges) [TESTÉ 21/09] |
| `carteGalaxie` | `true` (indicateur, pas la carte) [TESTÉ 21/09] |
| `menaces[]` | **Flottes hostiles en approche** [TESTÉ 22/09] : `{ fleetId, mission, arrivesAt, attaquant, origine: {galaxy,system,position}, cible: { coords: {galaxy,system,position}, body: "planet", nom }, palier: "exact", total, types: [{key,count}] }`. `types` donne la composition exacte de la flotte ennemie. L'UI affiche « Sondage » si `mission === "espionage"`, « Destruction de lune » si `destroyMoon`, sinon « Attaque » |
| `incoming[]` | Même famille, indexé par `fleetId` — **vide** pendant l'attaque observée le 22/09 (seul `menaces` était rempli) |
| `alertesVives[]` | **Événements déjà passés**, pas des menaces (aucun `arrivesAt`) [TESTÉ 22/09] : `{ id, type: "espionnage", at, donnees: { attaquant, corps, coords, envoyees, reperees } }` |
| `reports[]` | **Sans champ `kind` = combat subi** [TESTÉ 22/09] : `{ id, at, coords, attackerId, attackerName, defenderId, defenderName, planetName, outcome, rounds[], attackerLosses, defenderLosses, rebuiltDefences, attackerSurvivors, defenderSurvivors, plunder, debris, role, lu }`. `kind: "pirate"` : `{ tier, rounds, butin, attackerLosses, attackerSurvivors, garnisonDetruite, degatsCeRaid, repaireDetruit, rallies[], classement[] }`. `kind: "pirateTresor"` : `{ rang, degats, pertes, gain, classement[] }` |
| `arrivalReports[]` | [TESTÉ 22/09] `{ id, kind: "arrivee", mission: "retour", at, coords, body, ownerId, corps, ships{}, cargo{}, missionAller, raison, depuisBalise, role, lu }` |
| `spyReports[]` | `{ id, kind: "espionage", at, coords { galaxy, system, position }, attackerId, attackerName, defenderId, defenderName, planetName, probes, revenues, gap, levels, info, debris, counterEspionageRisk, probesLost, luPar[], role: "attacker"\|"defender", lu }` [TESTÉ 21/09] |
| `reports[]` | Rapports de combat. Vus : `kind: "pirate"` `{ id, at, coords, attackerId, ownerId, tier, rounds[], attackerLosses, attackerSurvivors, garnisonDetruite, garnisonRestante, degatsCeRaid, degatsCumules, classement, butin, repaireDetruit, rallies, luPar, role, lu }` et `kind: "pirateTresor"`. **Pas de champ `defenderId`** — un combat subi n'a pas encore été observé [TESTÉ 21/09] |
| `arrivalReports[]` | `{ id, kind: "arrivee", mission, at, coords, body, ownerId, corps, ships, cargo, missionAller, raison, depuisBalise, role, lu }` [TESTÉ 21/09] |
| `expeditionReports[]` | `{ id, kind: "expedition", at, coords, ownerId, issue (ex. smallFind), texte, etape, surTotal, heures, gain { metal, crystal, deuterium } }` [TESTÉ 21/09] |
| `unreadReports` | nombre [TESTÉ 21/09] |

---

## 4. Actions — économie

| Endpoint | Body | Statut |
|---|---|---|
| `POST /api/build` | `{ planetId, key }` | [BUNDLE] |
| `POST /api/build/cancel` | `{ planetId }` | [BUNDLE] |
| `POST /api/build/demolish` | `{ planetId, key }` | [BUNDLE] |
| `POST /api/research` | `{ planetId, key }` | [BUNDLE] |
| `POST /api/research/cancel` | `{}` | [BUNDLE] |
| `POST /api/ships` | `{ planetId, key, qty }` — vaisseaux **et** défenses | [BUNDLE] |
| `POST /api/ships/cancel` | `{ planetId }` | [BUNDLE] |
| `POST /api/efficiency` | `{ planetId, key, percent }` — ex. mine de métal 80 → 100 | [BUNDLE] |
| `POST /api/planet/rename` | `{ planetId, name }` | [BUNDLE] |

`key` = clés de `/api/state` : `metalMine`, `solarPlant`, `shipyard`, `weapons`, `cruiser`, `missileLauncher`…

---

## 5. Actions — flottes

### `POST /api/fleet` [TESTÉ en `transport`]
```json
{
  "planetId": "pl_2w",
  "mission": "transport",
  "coords": { "system": 17, "position": 6 },
  "speedPercent": 100,
  "ships": { "smallCargo": 3 },
  "cargo": { "metal": 10, "crystal": 0, "deuterium": 0 }
}
```

**Missions** — `transport` [TESTÉ] · lues dans le bundle [BUNDLE] :

| `mission` | Usage |
|---|---|
| `attack` | Attaque |
| `espionage` | Espionnage (sondes) |
| `deploy` | Stationner sur une de ses planètes |
| `recycle` | Champ de débris (recycleurs) |
| `expedition` | Position 16 — paramètre de durée **inconnu** |
| `colonize` | Colonisation |
| `livraison` | Contrat de livraison |
| `recuperation` | Épaves / signaux de détresse |
| `destroyMoon` | Étoile de la mort |

**Champs optionnels du body** lus dans le bundle le 21/09/2026 [BUNDLE] (`...re&&p?{rallier:!0}:{}` etc.) :

| Champ | Quand | Sens |
|---|---|---|
| `rallier: true` | attaque | case « Ralliement » / attendre l'allié (ACS) |
| `heures: <n>` | expédition | durée en heures (plafonnée côté client) |
| `holdHours: <n>` | balise (garde) | durée de garde en heures |
| `coords.body: "moon"` | toute mission | viser la lune plutôt que la planète |

Phases observées dans l'UI pour `fleets[]` : `outbound`, `returning`, `chargement`, `ralliement`, `garde` ; champs associés `rallieJusqua`, `gardeJusqua`, `chargeJusqua`, `exploringUntil`, `turnedAt`.

| Endpoint | Body | Statut |
|---|---|---|
| `POST /api/fleet/recall` | `{ fleetId }` — rappel / annulation | [BUNDLE] |
| `POST /api/fleet/ralliement/lancer` | `{ fleetId }` | [BUNDLE] |
| `POST /api/missiles` | `{ planetId, coords, qty, target }` — `target` = clé de défense visée [DÉDUIT] | [BUNDLE] |
| `POST /api/jump` | `{ from, to, ships }` — porte de saut | [BUNDLE] |
| `POST /api/phalanx` | `{ planetId, coords }` | [BUNDLE] |

---

## 6. Actions — commerce, rapports, divers

| Endpoint | Body | Statut |
|---|---|---|
| `POST /api/trade/create` | objet libre (forme inconnue) | [BUNDLE] |
| `POST /api/trade/accept` | `{ tradeId, planetId, message }` | [BUNDLE] |
| `POST /api/trade/decline` | `{ tradeId, message }` | [BUNDLE] |
| `POST /api/trade/cancel` | `{ tradeId }` | [BUNDLE] |
| `POST /api/negociant` | objet libre | [BUNDLE] |
| `POST /api/reports/read` | `{ reportId }` | [BUNDLE] |
| `POST /api/reports/dismiss` | `{ reportId }` | [BUNDLE] |
| `POST /api/journalier` | coffre quotidien (body non lu) | [BUNDLE] |
| `POST /api/element-dore` | `{}` | [BUNDLE] |

Autres endpoints vus dans l'objet client du bundle (21/09/2026) [BUNDLE] : `/api/moon/build`, `/api/moon/build/cancel`, `/api/moon/build/demolish`, `/api/moon/rename`,
`/api/pactes` (+ `/accepter`, `/refuser`, `/annuler`, `/rompre`), `/api/vacances` (+ `/fin`), `/api/profile/nickname|avatar|titre|theme`, `/api/voix`,
`/api/trade/replies/clear`, `/api/journalier/bonus {clics}`, `/api/artefacts/reveler {cle}`, `/api/egg {key}`, `/api/conduit {ms}`, `/api/visite-faite`, `/api/moissonneur/vu {id}`, `/api/annonces/vues`.

Hors périmètre : `/api/dev/*` (admin : sanction, boost, suppression de joueur…) — **ne jamais appeler**.

---

## 7. Formules calculées sur des données API

| Formule | Statut |
|---|---|
| `durée_ms = 4 800 000 × distance / vitesse_du_plus_lent` (speedPercent 100) | [CALCULÉ] exact à la ms sur 2 flottes |
| `distance = 2 700 + 95 × |Δ systèmes|` (même galaxie) | [HYPOTHÈSE] 2 points seulement |
| Vitesse = base × (1 + 0,1·combustion \| 0,2·impulsion \| 0,3·propulsion hyperespace) | [CALCULÉ] sur `player.vitesses`, contredit les descriptions in-game |
| `structure` (shipOptions) = métal + cristal du coût | [CALCULÉ] toutes unités |

---

## 8. À capturer / vérifier

1. ~~Échange du ticket (§1.3)~~ → les deux, testé le 21/09/2026.
2. Header **ou** cookie suffit-il seul ?
3. Réponse JSON de chaque POST
4. ~~Format de `menaces`~~ → confirmé en live le 22/09 (voir le tableau ci-dessus)
5. ~~Body d'une expédition et `rallier`~~ → `heures`, `rallier: true` lus dans le bundle le 21/09/2026
6. 3e envoi à un écart de systèmes différent (valider la formule de distance)
7. Effet de `speedPercent` < 100
