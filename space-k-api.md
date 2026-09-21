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
- Réponses des POST : **inconnues** sauf `/api/fleet` (à documenter au premier appel).

---

## 3. Lecture

| Méthode | Endpoint | Statut | Contenu |
|---|---|---|---|
| GET | `/api/state` | [TESTÉ] | **Tout** : joueur, recherches, 5 planètes, flottes en vol, `incoming`, `menaces`, rapports, contrats, échanges, pactes |
| GET | `/api/galaxy/carte` | [BUNDLE] | Carte de la galaxie |
| GET | `/api/leaderboard` | [BUNDLE] | Classement |
| GET | `/api/codex?planetId=<id>` | [BUNDLE] | Codex (prérequis) |
| GET | `/api/profile/<nom>` | [BUNDLE] | Profil d'un joueur |
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
| `planets[].buildQueue / shipQueue / shipQueueSuite` | Files en cours (`null` = libre) |
| `planets[].buildOptions / shipOptions / defenceOptions / researchOptions` | **Coûts et durées** du prochain niveau / par unité |
| `fleets[]` | Flottes en vol : `id`, `mission`, `ships`, `phase`, `departsAt`, `arrivesAt`, `returnsAt`, `distance`, `fuel` |
| `fleetSlots`, `expedition` | Slots libres, expéditions restantes |
| `menaces[]` | **Flottes hostiles en approche** [BUNDLE, jamais vu en live] : `{ fleetId, mission, attaquant, cible: { nom, coords }, arrivesAt }`. L'UI affiche « Sondage » si `mission === "espionage"`, « Destruction de lune » si `destroyMoon`, sinon « Attaque » |
| `incoming[]` | Même famille, indexé par `fleetId` (toasts) [BUNDLE] |
| `alertesVives[]`, `assautsSubis[]` | Alertes indexées par `id` (format des éléments non lu) [BUNDLE] |
| `spyReports`, `reports`, `arrivalReports`, `expeditionReports` | Rapports |

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
4. Format de `menaces` : lu dans le bundle (fleetId, mission, attaquant, cible, arrivesAt) — à confirmer en live
5. ~~Body d'une expédition et `rallier`~~ → `heures`, `rallier: true` lus dans le bundle le 21/09/2026
6. 3e envoi à un écart de systèmes différent (valider la formule de distance)
7. Effet de `speedPercent` < 100
