// Bot Space-K — cœur : boucle de poll, fleet-save par planète, collect, capture de données, résumés (l'auto-ravitaillement vit dans supply.ts).
//   npx tsx --env-file=.env bot.ts watch     → boucle complète (selon flags)
//   npx tsx --env-file=.env bot.ts status    → résumé texte
// Modules : core.ts (client, flags, helpers) · threats.ts · presets.ts · scan.ts · expedition.ts · notify.ts · autobuild.ts · nextbuild.ts
//           supply.ts (auto-ravitaillement par colonie) · deut.ts (plafond de deut des colonies → Père) · fleetbuild.ts (vaisseaux construits en colonie, payés par Père) · pirates.ts · salvage.ts
//
// Par défaut tout est en MODE OBSERVATION (SAVE_ARMED / COLLECT_ENABLED = false) : le bot calcule, logue et notifie ce qu'il ferait,
// mais n'émet aucun POST automatique. Auto-construction et auto-ravitaillement : désactivés tant qu'aucune planète n'est activée.
import type { Coords, Fleet, Planet, Res, State } from "./spacek-client.ts";
import {
  PERE, CARGO, NEVER_FLY, DEUT_RESERVE, api, alert, appendJsonl, capacity, etaStr, fillCargo, flags, fleetResultStr, fmt, getFlags,
  getHealth, getState, log, num, recordError, resStr, roundRes, same, sendFleetFuelSafe, shipsStr, sleep, xy,
} from "./core.ts";
import { parseThreats, threatDesc, threatLabel, threatenedPlanetIds, triggersSave, type Threat } from "./threats.ts";
import { notifyTick } from "./notify.ts";
import { autobuildTick } from "./autobuild.ts";
import { piratesTick } from "./pirates.ts";
import { salvageTick } from "./salvage.ts";
import { nextBuildTick } from "./nextbuild.ts";
import { autoExploTick } from "./expedition.ts";
import { supplyEnabled, supplyTarget, supplyTick } from "./supply.ts";
import { fleetBuildReserved, fleetBuildTick } from "./fleetbuild.ts";
import { autoDeutTick } from "./deut.ts";
export * from "./core.ts";
export * from "./threats.ts";

// ================= CONFIG =================
const SUPPLY_TICK_MS = 60_000; // évaluation de l'auto-ravitaillement (chaque colonie active n'est servie qu'à son échéance, supply.ts)
const COLLECT_EVERY_MS = 60_000;
const COLLECT_THRESHOLD = num("COLLECT_THRESHOLD", 0.9); // déclenche quand une ressource dépasse 90 % de la capacité
const COLLECT_KEEP = num("COLLECT_KEEP", 0.5);           // …et ramène le stock à 50 % (évite un vol toutes les minutes)
const COLLECT_MIN_SEND = 2_000;
const POLL_MS = num("POLL_MS", 10_000); // poll normal (± 20 % de jitter) — jamais de poll rapide : ça attirerait les soupçons
const MIN_SLEEP_MS = 200;             // au lieu d'accélérer, on dort jusqu'à l'échéance exacte (décollage / rappel) puis un seul appel
const SAVE_BEFORE_MS = num("SAVE_BEFORE_MS", 10_000);  // décollage X ms avant l'impact (sonde OU attaque)
const RECALL_AFTER_MS = num("RECALL_AFTER_MS", 1_500); // rappel X ms après le dernier impact
// ==========================================

// ---------- 1. Fleet-save par planète ----------
type SaveState = { dest: string; fleetId?: string; recallAt: number; simulated: boolean; sentAt: number };
const saves = new Map<string, SaveState>();     // planetId → save en cours
const announced = new Set<string>();            // menaces déjà notifiées
const noSave = new Map<string, string>();       // planetId → vagues pour lesquelles il n'y avait rien à sauver

/** Destination : la planète la plus proche non menacée si possible, sinon la plus proche (être en vol suffit). */
function pickDest(s: State, p: Planet, threatened: Set<string>): Planet | undefined {
  const others = s.planets.filter((x) => x.id !== p.id)
    .sort((a, b) => Math.abs(a.coords.system - p.coords.system) - Math.abs(b.coords.system - p.coords.system));
  return others.find((x) => !threatened.has(x.id)) ?? others[0];
}

/** Renvoie false si aucun décollage n'a été enregistré (rien à sauver) : pas de rappel à annoncer ensuite. */
async function doSave(s: State, p: Planet, threats: Threat[], recallAt: number, threatened: Set<string>): Promise<boolean> {
  const ships = Object.fromEntries(Object.entries(p.ships).filter(([k, n]) => n > 0 && !NEVER_FLY.has(k)));
  const dest = pickDest(s, p, threatened);
  const eta = etaStr(Math.min(...threats.map((t) => t.arrivesAt)) - s.now);
  if (!Object.keys(ships).length) {
    alert(`⚠️ ${p.name} : impact dans ${eta} mais AUCUN vaisseau sur place — rien à faire décoller (les ressources ne peuvent pas être évacuées sans transporteur)`);
    return false;
  }
  if (!dest) { alert(`⚠️ ${p.name} : impact dans ${eta} mais aucune destination de repli`); return false; }
  const cap = capacity(ships); // 100 % de la soute, arrondi à l'entier (une soute fractionnaire est refusée)
  const cargo = fillCargo(p.resources, cap);
  const what = `${p.name} → ${dest.name} : ${shipsStr(ships)} · ${resStr(cargo)} · ${threats.length} vague(s), rappel à +${Math.round((recallAt - s.now) / 1000)} s`;
  if (s.fleetSlots.used >= s.fleetSlots.total) { alert(`SAVE IMPOSSIBLE (aucun slot ${s.fleetSlots.used}/${s.fleetSlots.total}) ${what}`); saves.set(p.id, { dest: dest.id, recallAt, simulated: true, sentAt: s.now }); return true; }
  if (!flags.save) { alert(`[OBSERVATION] j'AURAIS décollé : ${what}`); saves.set(p.id, { dest: dest.id, recallAt, simulated: true, sentAt: s.now }); return true; }
  const { res, note } = await sendFleetFuelSafe(
    { planetId: p.id, mission: "deploy", coords: xy(dest.coords), ships, cargo, speedPercent: 100 },
    p.resources, cap, new Set(s.fleets.map((f) => f.id)));
  saves.set(p.id, { dest: dest.id, fleetId: res.fleetId, recallAt, simulated: false, sentAt: s.now });
  alert(`SAVE ${what}${note ? `\n${note}` : ""}\n${fleetResultStr(res)}`);
  return true;
}

async function doRecall(s: State, p: Planet, st: SaveState) {
  saves.delete(p.id);
  if (!st.dest) return; // il n'y avait rien à sauver
  if (st.simulated) { alert(`[OBSERVATION] j'AURAIS rappelé la flotte de ${p.name} maintenant`); return; }
  // Si la réponse du POST n'a pas donné d'id : flotte deploy la plus récente partie de p
  const mine = st.fleetId
    ? s.fleets.find((f) => f.id === st.fleetId)
    : s.fleets.filter((f) => f.origin?.planetId === p.id && f.mission === "deploy" && f.phase === "outbound" && (f.departsAt ?? 0) >= st.sentAt - 5_000)
        .sort((a, b) => (b.departsAt ?? 0) - (a.departsAt ?? 0))[0];
  if (!mine) { alert(`Flotte de ${p.name} introuvable en vol (déjà posée sur la destination ?) → la ramener avec /deploy`); return; }
  await api.recall(mine.id); // la réponse est l'état complet : on ne l'affiche pas
  alert(`RECALL ${p.name} · flotte ${mine.id} rappelée`);
}

async function fleetSaveTick(s: State, threats: Threat[]) {
  const triggers = threats.filter(triggersSave);
  for (const t of threats) {
    if (announced.has(t.id)) continue;
    announced.add(t.id);
    alert(threatDesc(t, s));
  }
  const threatened = threatenedPlanetIds(s, threats);
  for (const p of s.planets) {
    const mine = triggers.filter((t) => same(t.target, p.coords));
    const st = saves.get(p.id);
    if (mine.length) {
      // Menace périmée (impact déjà passé mais encore listée) : on ne décolle pas après coup
      if (!st && mine.every((t) => t.arrivesAt <= s.now)) continue;
      const saveAt = Math.min(...mine.map((t) => t.arrivesAt)) - SAVE_BEFORE_MS;
      const recallAt = Math.max(...mine.map((t) => t.arrivesAt)) + RECALL_AFTER_MS;
      const key = mine.map((t) => t.id).sort().join(",");
      if (st) { if (recallAt > st.recallAt) { st.recallAt = recallAt; log("Nouvelle vague sur", p.name, "→ rappel repoussé"); } }
      else if (s.now >= saveAt && noSave.get(p.id) !== key) {
        const done = await doSave(s, p, mine, recallAt, threatened).catch((e) => { alert(`SAVE KO ${p.name} : ${e.message}`); return true; });
        if (!done) noSave.set(p.id, key); // rien à sauver : on ne réessaie pas à chaque poll
      }
    } else if (st && s.now >= st.recallAt) {
      await doRecall(s, p, st).catch((e) => alert("RECALL KO", p.name, e.message));
    }
  }
  // Une menace disparue avant l'impact (attaquant qui rappelle) : rien à faire, on n'a pas décollé.
  // Si on avait déjà décollé, le rappel se fait à recallAt comme prévu.
}

// ---------- 2. Ravitaillement auto depuis Père : supply.ts ----------
let lastSupply = 0;

// ---------- 3. Collecte colonies → Père (BetweenLands déborde) ----------
let lastCollect = 0;
/** Ce que collect ramènerait de p (null = pas de déclenchement). Ravitaillement actif SUR p : niveau gardé = max(COLLECT_KEEP × capacité, cible supply)
 *  et déclenchement seulement s'il y a un vrai excédent au-dessus → jamais d'aller-retour avec supply. Ravitaillement off sur p : inchangé. */
export function collectWant(p: Planet, supplyOn = supplyEnabled(p.id)): Res | null {
  const t = supplyOn ? supplyTarget(p.id) : undefined;
  const base = (k: keyof Res) => Math.max(COLLECT_KEEP * p.capacities[k], t?.[k] ?? 0);
  const reserve = (k: keyof Res) => (k === "deuterium" ? DEUT_RESERVE : 0);
  const over = (Object.keys(p.resources) as (keyof Res)[]).some((k) => p.capacities[k] > 0 && p.resources[k] > COLLECT_THRESHOLD * p.capacities[k]
    && (!t || p.resources[k] > base(k) + reserve(k)));
  if (!over) return null;
  const excess = (k: keyof Res) => Math.max(0, Math.floor(p.resources[k] - base(k)));
  return { metal: excess("metal"), crystal: excess("crystal"), deuterium: Math.max(0, excess("deuterium") - DEUT_RESERVE) };
}
async function collect(s: State, threatened: Set<string>) {
  const pere = s.planets.find((p) => p.id === PERE);
  if (!pere || threatened.has(PERE)) return;
  for (const p of s.planets) {
    if (p.id === PERE || threatened.has(p.id) || fleetBuildReserved(p.id)) continue; // /fleetbuild : ressources livrées, pas encore lancées
    const want = collectWant(p);
    if (!want) continue;
    if (s.fleets.some((f) => f.mission === "transport" && f.phase === "outbound" && f.origin?.planetId === p.id && same(f.target?.coords, pere.coords))) continue;
    const total = want.metal + want.crystal + want.deuterium;
    if (total < COLLECT_MIN_SEND) continue;
    // Transporteurs sur place : GT d'abord, PT en complément
    const ships: Record<string, number> = {};
    let cap = 0;
    for (const k of ["largeCargo", "smallCargo"]) {
      const n = Math.min(p.ships[k] ?? 0, Math.ceil(Math.max(0, total - cap) / CARGO[k]));
      if (n > 0) { ships[k] = n; cap += n * CARGO[k]; }
    }
    if (!cap) { log("COLLECT : aucun transporteur sur", p.name); continue; }
    const cargo = fillCargo({ ...want, deuterium: want.deuterium + DEUT_RESERVE }, cap);
    if (s.fleetSlots.used >= s.fleetSlots.total) { log("COLLECT : aucun slot libre"); return; }
    const what = `${p.name} → Père : ${shipsStr(ships)} · ${resStr(cargo)}`;
    if (!flags.collect) { log(`[OBSERVATION] COLLECT j'aurais envoyé ${what}`); continue; }
    const col = await sendFleetFuelSafe({ planetId: p.id, mission: "transport", coords: xy(pere.coords), ships, cargo, speedPercent: 100 },
      p.resources, cap, new Set(s.fleets.map((f) => f.id)));
    alert(`COLLECT ${what}${col.note ? `\n${col.note}` : ""}\n${fleetResultStr(col.res)}`);
    s.fleetSlots.used++;
  }
}

// ---------- 4. Capture de données (formule carburant / distance) ----------
const seenFleets = new Set<string>();
function sampleFleets(s: State) {
  for (const f of s.fleets ?? []) {
    if (!f.id || seenFleets.has(f.id)) continue;
    seenFleets.add(f.id);
    appendJsonl("fleet-samples.jsonl", {
      now: s.now, id: f.id, mission: f.mission, ships: f.ships, distance: f.distance, fuel: f.fuel,
      speedPercent: f.speedPercent, departsAt: f.departsAt, arrivesAt: f.arrivesAt, returnsAt: f.returnsAt,
      origin: f.origin?.coords ?? f.origin, target: f.target?.coords ?? f.target,
    });
  }
  if (seenFleets.size > 5_000) seenFleets.clear();
}

// ---------- Résumés texte ----------
export function statusSummary(s: State): string {
  const threats = parseThreats(s);
  const h = getHealth();
  const f = getFlags();
  const e = s.expedition;
  const lines = [
    `Slots ${s.fleetSlots.used}/${s.fleetSlots.total} · ${s.fleets.length} flotte(s) en vol · ${threats.length} menace(s)` +
      (e ? ` · expé ${e.inFlight}/${e.slots} (${e.lanceesAujourdhui}/${e.maxPerPlayerPer24h} auj.)` : ""),
    `Flags : save ${f.save ? "ARMÉ" : "observation"} · autosupply ${s.planets.filter((p) => supplyEnabled(p.id)).length} colonie(s) · collect ${f.collect ? "on" : "off"} · explo auto ${f.explo ? "on" : "off"} · deut→Père ${f.deut ? "on" : "off"} · autobuild ${f.autobuild ? "on" : "off"}`,
    `Latence /state ${h.avgLatencyMs} ms · ${h.polls} polls · ${h.errors} erreurs · uptime ${Math.round(h.uptimeMs / 60_000)} min`,
    ...s.planets.map((p) => `• ${p.name} ${fmt(p.coords)} — ${resStr(roundRes(p.resources))}${p.buildQueue ? ` 🏗 ${p.buildQueue.key} ${p.buildQueue.targetLevel}` : ""}${p.shipQueue ? ` 🚀 ${p.shipQueue.remaining} ${p.shipQueue.key}` : ""}`),
    s.player.researchQueue ? `🔬 ${s.player.researchQueue.key} niv. ${s.player.researchQueue.targetLevel} — fin dans ${Math.max(0, Math.round((s.player.researchQueue.finishesAt - s.now) / 60_000))} min` : "",
  ];
  return lines.filter(Boolean).join("\n");
}
/** /flotte : vaisseaux à quai par planète (Père d'abord) + flottes en vol. */
export function shipsSummary(s: State): string {
  const order = [...s.planets].sort((a, b) => (a.id === PERE ? -1 : b.id === PERE ? 1 : 0));
  const lines = order.map((p) => `• ${p.name} ${fmt(p.coords)}\n  ${shipsStr(Object.fromEntries(Object.entries(p.ships).filter(([k]) => !NEVER_FLY.has(k))))}`);
  if (s.fleets.length) lines.push(`\nEn vol : ${s.fleets.length}`, ...s.fleets.map((f) => `  ↳ ${f.mission} ${shipsStr(f.ships ?? {})} → ${f.target?.coords ? fmt(f.target.coords) : "?"}`));
  return lines.join("\n");
}
export function planetsSummary(s: State): string {
  return s.planets.map((p) => [
    `• ${p.name} (${p.id}) ${fmt(p.coords)}`,
    `  ${resStr(roundRes(p.resources))} / cap ${resStr(p.capacities)}`,
    `  ${shipsStr(p.ships)}`,
  ].join("\n")).join("\n");
}
export function fleetsSummary(s: State): string {
  if (!s.fleets.length) return "Aucune flotte en vol.";
  return s.fleets.map((f: Fleet) =>
    `• ${f.id} ${f.mission} ${f.phase ?? ""} ${shipsStr(f.ships ?? {})} → ${f.target?.coords ? fmt(f.target.coords) : "?"} · arrivée dans ${f.arrivesAt ? Math.round((f.arrivesAt - s.now) / 1000) : "?"} s`,
  ).join("\n");
}
export function threatsSummary(s: State): string {
  const ts = parseThreats(s);
  if (!ts.length) return "Aucune menace.";
  return ts.map((t) => `• ${threatDesc(t, s)}`).join("\n");
}

/** Prochain réveil : le poll normal (avec jitter), ou plus tôt si une échéance (décollage / rappel) tombe avant.
 *  Pas de poll rapide : un seul appel supplémentaire, calé sur l'échéance en horloge serveur. */
function pollDelay(s: State, threats: Threat[]): number {
  const deadlines = [
    ...threats.filter((t) => triggersSave(t) && !saves.has(planetIdAt(s, t.target) ?? "")).map((t) => t.arrivesAt - SAVE_BEFORE_MS),
    ...[...saves.values()].map((st) => st.recallAt),
  ].filter((d) => d > s.now);
  const normal = POLL_MS * (0.8 + Math.random() * 0.4);
  const next = deadlines.length ? Math.min(...deadlines) - s.now : Infinity;
  return Math.max(MIN_SLEEP_MS, Math.min(normal, next));
}
const planetIdAt = (s: State, c: Coords) => s.planets.find((p) => same(p.coords, c))?.id;

/** Erreurs remontées sur Telegram à la 1re occurrence, puis au plus une fois toutes les 15 min par message identique. */
const errorSeen = new Map<string, number>();
function notifyError(msg: string) {
  const key = msg.replace(/\d+/g, "#").slice(0, 80);
  const last = errorSeen.get(key) ?? 0;
  if (Date.now() - last < 15 * 60_000) return;
  errorSeen.set(key, Date.now());
  alert(`❌ ERREUR bot : ${msg.slice(0, 600)}`);
}

// ---------- Boucle ----------
export async function watch() {
  log("watch démarré", getFlags());
  for (;;) {
    try {
      const s = await getState();
      sampleFleets(s);
      const threats = parseThreats(s);
      await fleetSaveTick(s, threats);
      await piratesTick(s).catch((e) => log("PIRATES KO", e.message));
      await salvageTick(s).catch((e) => log("SALVAGE KO", e.message));
      try { notifyTick(s, threats); } catch (e: any) { log("NOTIFY KO", e.message); }
      const threatened = threatenedPlanetIds(s, threats);
      await fleetBuildTick(s).catch((e) => alert("FLEETBUILD KO", e.message)); // chaque poll, avant collect / next / autobuild (ressources livrées)
      if (Date.now() - lastSupply > SUPPLY_TICK_MS) { lastSupply = Date.now(); await supplyTick(s, threatened).catch((e) => alert("SUPPLY KO", e.message)); }
      await autoExploTick(s, threatened).catch((e) => alert("EXPLO AUTO KO", e.message));
      await autoDeutTick(s, threatened).catch((e) => alert("DEUT KO", e.message)); // garde interne : une évaluation par minute
      if (Date.now() - lastCollect > COLLECT_EVERY_MS) { lastCollect = Date.now(); await collect(s, threatened).catch((e) => alert("COLLECT KO", e.message)); }
      await nextBuildTick(s).catch((e) => log("NEXT KO", e.message));
      await autobuildTick(s).catch((e) => alert("AUTOBUILD KO", e.message));
      await sleep(pollDelay(s, threats));
    } catch (e: any) {
      recordError(e.message);
      log("ERR", e.message);
      notifyError(e.message);
      await sleep(10_000);
    }
  }
}

// ---------- CLI ----------
const isMain = /bot\.ts$/.test(process.argv[1] ?? "");
if (isMain) {
  const [cmd] = process.argv.slice(2);
  if (cmd === "watch") watch();
  else if (cmd === "status") getState().then((s) => console.log(statusSummary(s))).catch((e) => { log(e.message); process.exit(1); });
  else console.log("Usage : watch | status");
}
