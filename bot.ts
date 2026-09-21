// Bot Space-K — cœur métier, importé par telegram.ts ou utilisable en CLI :
//   npx tsx --env-file=.env bot.ts attack p0 25:11   → envoie un preset depuis Père
//   npx tsx --env-file=.env bot.ts watch             → fleet-save + supply + collect (selon flags)
//   npx tsx --env-file=.env bot.ts status            → résumé texte
//
// Par défaut tout est en MODE OBSERVATION (SAVE_ARMED / SUPPLY_ENABLED / COLLECT_ENABLED = false) :
// le bot calcule, logue et notifie ce qu'il ferait, mais n'émet aucun POST /fleet automatique.
import { appendFileSync } from "node:fs";
import { SpaceK, type Coords, type Fleet, type Mission, type Planet, type Res, type State, planetByName } from "./spacek-client.ts";

export const PERE = "pl_2w";

// ================= CONFIG =================
export const PRESETS: Record<string, Record<string, number>> = {
  p0: { cruiser: 7, largeCargo: 10 },   // avec butin
  "p0-sec": { cruiser: 7 },             // sans butin
  // p1: { ... },                        // ← composition à fournir
};

// Stock minimal visé sur chaque colonie, complété depuis Père (vide = désactivé)
export const SUPPLY: Record<string, Partial<Res>> = {
  // pl_rn: { metal: 100_000, crystal: 50_000, deuterium: 20_000 },  // Planète Fils
};
const SUPPLY_EVERY_MS = 60_000;
const SUPPLY_MIN_SEND = 20_000;       // pas de vol pour moins que ça
const COLLECT_EVERY_MS = 60_000;
const COLLECT_THRESHOLD = num("COLLECT_THRESHOLD", 0.9); // déclenche quand une ressource dépasse 90 % de la capacité
const COLLECT_KEEP = num("COLLECT_KEEP", 0.5);           // …et ramène le stock à 50 % (évite un vol toutes les minutes)
const COLLECT_MIN_SEND = 2_000;
const POLL_MS = num("POLL_MS", 10_000); // poll normal (± 20 % de jitter) — jamais de poll rapide : ça attirerait les soupçons
const MIN_SLEEP_MS = 200;             // au lieu d'accélérer, on dort jusqu'à l'échéance exacte (décollage / rappel) puis un seul appel
const SAVE_BEFORE_MS = num("SAVE_BEFORE_MS", 5_000);   // décollage X ms avant l'impact
const RECALL_AFTER_MS = num("RECALL_AFTER_MS", 1_500); // rappel X ms après le dernier impact
const DEUT_RESERVE = num("DEUT_RESERVE", 5_000);       // deut laissé pour le carburant (conso inconnue → à ajuster)

// Soutes de base (vaisseaux.md). Satellites : ne volent jamais.
export const CARGO: Record<string, number> = {
  smallCargo: 5_000, largeCargo: 25_000, lightFighter: 50, heavyFighter: 100, cruiser: 800,
  battleship: 1_500, colonyShip: 7_500, espionageProbe: 5, recycler: 20_000, pathfinder: 10_000,
  bomber: 500, destroyer: 2_000, battlecruiser: 750, deathStar: 1_000_000,
};
const NEVER_FLY = new Set(["solarSatellite"]);
// ==========================================

function num(k: string, d: number) { const v = Number(process.env[k]); return Number.isFinite(v) && process.env[k] ? v : d; }
function bool(k: string, d = false) { const v = process.env[k]; return v == null || v === "" ? d : /^(1|true|on|yes)$/i.test(v); }

// ---------- Flags (modifiables à chaud depuis Telegram) ----------
export type Flags = { save: boolean; supply: boolean; collect: boolean };
const flags: Flags = { save: bool("SAVE_ARMED"), supply: bool("SUPPLY_ENABLED"), collect: bool("COLLECT_ENABLED") };
let pausedFrom: Flags | null = null;
export const getFlags = (): Flags => ({ ...flags });
export function setFlag(k: keyof Flags, v: boolean) { flags[k] = v; log("FLAG", k, "=", v); return getFlags(); }
export function pause() { if (!pausedFrom) pausedFrom = { ...flags }; (Object.keys(flags) as (keyof Flags)[]).forEach((k) => (flags[k] = false)); log("PAUSE"); return getFlags(); }
export function resume() { if (pausedFrom) Object.assign(flags, pausedFrom); pausedFrom = null; log("RESUME", flags); return getFlags(); }

// ---------- Outils ----------
export const api = new SpaceK();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const xy = (c: any): Coords => ({ system: c.system, position: c.position });
const same = (a: any, b: any) => !!a && !!b && a.system === b.system && a.position === b.position;
const fmt = (c: Coords) => `${c.system}:${c.position}`;
export const log = (...a: any[]) => console.log(new Date().toISOString(), ...a);
let notify: ((msg: string) => void) | null = null;
export const setNotify = (fn: (msg: string) => void) => { notify = fn; };
export const alert = (...a: any[]) => { log(...a); notify?.(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
const shipsStr = (s: Record<string, number>) => Object.entries(s).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(", ") || "—";
const resStr = (r: Res) => `M ${r.metal} · C ${r.crystal} · D ${r.deuterium}`;
function appendJsonl(file: string, obj: object) { try { appendFileSync(file, JSON.stringify(obj) + "\n"); } catch (e: any) { log("jsonl KO", file, e.message); } }

// ---------- Santé (pour /status et le heartbeat) ----------
const health = { startedAt: Date.now(), lastPollAt: 0, polls: 0, errors: 0, lastError: "", latencies: [] as number[] };
export function getHealth() {
  const l = health.latencies;
  return { ...health, avgLatencyMs: l.length ? Math.round(l.reduce((a, b) => a + b, 0) / l.length) : 0, uptimeMs: Date.now() - health.startedAt };
}
export async function getState(): Promise<State> {
  const t0 = Date.now();
  const s = await api.state();
  health.latencies.push(Date.now() - t0); if (health.latencies.length > 20) health.latencies.shift();
  health.lastPollAt = Date.now(); health.polls++;
  return s;
}

// ---------- Envoi de flotte générique (vérifs + résumé, exécution séparée pour la confirmation Telegram) ----------
export type FleetPlan = {
  payload: { planetId: string; mission: Mission; coords: Coords; ships: Record<string, number>; cargo: Res; speedPercent: number };
  summary: string;
};
export function prepareFleet(s: State, o: {
  from: string; mission: Mission; coords: Coords; ships: Record<string, number>; cargo?: Partial<Res>; speedPercent?: number;
}): FleetPlan {
  const p = planetByName(s, o.from);
  if (!p) throw new Error(`Planète inconnue : ${o.from}`);
  const ships = Object.fromEntries(Object.entries(o.ships).filter(([, n]) => n > 0));
  if (!Object.keys(ships).length) throw new Error("Aucun vaisseau");
  const manque = Object.entries(ships).filter(([k, n]) => (p.ships[k] ?? 0) < n);
  if (manque.length) throw new Error(`Manque sur ${p.name} : ` + manque.map(([k, n]) => `${k} ${p.ships[k] ?? 0}/${n}`).join(", "));
  if (s.fleetSlots.used >= s.fleetSlots.total) throw new Error(`Aucun slot de flotte libre (${s.fleetSlots.used}/${s.fleetSlots.total})`);
  const cargo: Res = { metal: 0, crystal: 0, deuterium: 0, ...o.cargo };
  const cap = capacity(ships);
  const total = cargo.metal + cargo.crystal + cargo.deuterium;
  if (total > cap) throw new Error(`Soute insuffisante : ${total} > ${cap}`);
  (Object.keys(cargo) as (keyof Res)[]).forEach((k) => { if (cargo[k] > Math.floor(p.resources[k])) throw new Error(`Pas assez de ${k} sur ${p.name} (${Math.floor(p.resources[k])})`); });
  const payload = { planetId: p.id, mission: o.mission, coords: xy(o.coords), ships, cargo, speedPercent: o.speedPercent ?? 100 };
  const dest = s.planets.find((x) => same(x.coords, payload.coords));
  const summary = [
    `${o.mission} depuis ${p.name} (${fmt(p.coords)}) → ${fmt(payload.coords)}${dest ? ` (${dest.name})` : ""}`,
    `Vaisseaux : ${shipsStr(ships)}`,
    total ? `Cargo : ${resStr(cargo)} / soute ${cap}` : `Cargo : vide (soute ${cap})`,
    `Vitesse ${payload.speedPercent} % · slots ${s.fleetSlots.used}/${s.fleetSlots.total}`,
  ].join("\n");
  return { payload, summary };
}
export const capacity = (ships: Record<string, number>) => Object.entries(ships).reduce((a, [k, n]) => a + (CARGO[k] ?? 0) * n, 0);
export async function sendFleet(plan: FleetPlan) {
  const r = await api.sendFleet(plan.payload);
  log("FLEET", plan.payload.mission, plan.payload.planetId, "→", fmt(plan.payload.coords), r);
  return r;
}

// ---------- 1. Presets d'attaque ----------
export function planAttack(s: State, preset: string, pos: string, speedPercent = 100): FleetPlan {
  const ships = PRESETS[preset];
  if (!ships) throw new Error(`Preset inconnu : ${preset} (dispo : ${Object.keys(PRESETS).join(", ")})`);
  return prepareFleet(s, { from: PERE, mission: "attack", coords: parseCoords(pos), ships, speedPercent });
}
export async function attack(preset: string, pos: string, speedPercent = 100) {
  const plan = planAttack(await getState(), preset, pos, speedPercent);
  return sendFleet(plan);
}
export function parseCoords(pos: string): Coords {
  const m = pos.match(/^(\d+):(\d+)$/);
  if (!m) throw new Error(`Coordonnées invalides : ${pos} (attendu système:position)`);
  return { system: +m[1], position: +m[2] };
}

// ---------- 2. Menaces ----------
export type Threat = { id: string; mission?: string; arrivesAt: number; target: Coords; raw: any };
let lastIncomingSample = "";

/** ⚠️ FORMAT INCONNU : meilleur effort d'après la forme de `fleets[]`. À corriger avec le 1er échantillon (incoming-samples.jsonl). */
export function parseThreats(s: State): Threat[] {
  const raw = [...(s.incoming ?? []), ...(s.menaces ?? []), ...(s.alertesVives ?? [])];
  if (raw.length) {
    const sample = JSON.stringify({ incoming: s.incoming, menaces: s.menaces, alertesVives: s.alertesVives });
    if (sample !== lastIncomingSample) {
      lastIncomingSample = sample;
      appendJsonl("incoming-samples.jsonl", { now: s.now, ...JSON.parse(sample) });
      // Format inconnu → on notifie TOUJOURS le brut : au pire un JSON moche, jamais le silence
      alert(`⚠️ ACTIVITÉ ENTRANTE (brut, ${raw.length} élément(s)) :\n${sample.slice(0, 1500)}`);
    }
  }
  const out = new Map<string, Threat>();
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const id = String(f.id ?? f.fleetId ?? f.uid ?? "");
    const arrivesAt = Number(f.arrivesAt ?? f.arrivalAt ?? f.arriveAt ?? f.arrival ?? f.impactAt ?? NaN);
    const target = f.target?.coords ?? f.coords ?? f.target ?? f.destination?.coords ?? f.planet?.coords;
    if (!id || !Number.isFinite(arrivesAt) || !target?.system) continue;
    out.set(id, { id, mission: f.mission ?? f.type, arrivesAt, target: xy(target), raw: f });
  }
  return [...out.values()];
}
/** Une menace compte comme attaque si mission === "attack", ou si le champ mission est absent (format inconnu → prudence). [HYPOTHÈSE] */
export const isAttack = (t: Threat) => t.mission === undefined || t.mission === "attack";
export const threatenedPlanetIds = (s: State, threats: Threat[]) =>
  new Set(threats.filter(isAttack).map((t) => s.planets.find((p) => same(p.coords, t.target))?.id).filter(Boolean) as string[]);

// ---------- 3. Fleet-save par planète ----------
type SaveState = { dest: string; fleetId?: string; recallAt: number; simulated: boolean; sentAt: number };
const saves = new Map<string, SaveState>();     // planetId → save en cours
const announced = new Set<string>();            // menaces déjà notifiées

function fillCargo(r: Res, cap: number): Res {
  const d = Math.min(Math.max(0, Math.floor(r.deuterium) - DEUT_RESERVE), cap); cap -= d;
  const c = Math.min(Math.floor(r.crystal), cap); cap -= c;
  const m = Math.min(Math.floor(r.metal), cap);
  return { metal: m, crystal: c, deuterium: d };
}
/** Destination : la planète la plus proche non menacée si possible, sinon la plus proche (être en vol suffit). */
function pickDest(s: State, p: Planet, threatened: Set<string>): Planet | undefined {
  const others = s.planets.filter((x) => x.id !== p.id)
    .sort((a, b) => Math.abs(a.coords.system - p.coords.system) - Math.abs(b.coords.system - p.coords.system));
  return others.find((x) => !threatened.has(x.id)) ?? others[0];
}

async function doSave(s: State, p: Planet, threats: Threat[], recallAt: number, threatened: Set<string>) {
  const ships = Object.fromEntries(Object.entries(p.ships).filter(([k, n]) => n > 0 && !NEVER_FLY.has(k)));
  const dest = pickDest(s, p, threatened);
  if (!Object.keys(ships).length || !dest) { log("Rien à sauver sur", p.name); saves.set(p.id, { dest: dest?.id ?? "", recallAt, simulated: true, sentAt: s.now }); return; }
  const cargo = fillCargo(p.resources, capacity(ships) * 0.9);
  const what = `${p.name} → ${dest.name} : ${shipsStr(ships)} · ${resStr(cargo)} · ${threats.length} vague(s), rappel à +${Math.round((recallAt - s.now) / 1000)} s`;
  if (s.fleetSlots.used >= s.fleetSlots.total) { alert(`SAVE IMPOSSIBLE (aucun slot ${s.fleetSlots.used}/${s.fleetSlots.total}) ${what}`); saves.set(p.id, { dest: dest.id, recallAt, simulated: true, sentAt: s.now }); return; }
  if (!flags.save) { alert(`[OBSERVATION] j'AURAIS décollé : ${what}`); saves.set(p.id, { dest: dest.id, recallAt, simulated: true, sentAt: s.now }); return; }
  const r: any = await api.sendFleet({ planetId: p.id, mission: "deploy", coords: xy(dest.coords), ships, cargo });
  const fleetId = r?.fleetId ?? r?.id ?? r?.fleet?.id; // réponse du POST inconnue [DÉDUIT]
  saves.set(p.id, { dest: dest.id, fleetId, recallAt, simulated: false, sentAt: s.now });
  alert(`SAVE ${what}`, fleetId ? `fleet ${fleetId}` : r);
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
  alert(`RECALL ${p.name}`, mine.id, await api.recall(mine.id));
}

async function fleetSaveTick(s: State, threats: Threat[]) {
  const attacks = threats.filter(isAttack);
  for (const t of threats) {
    if (announced.has(t.id)) continue;
    announced.add(t.id);
    const p = s.planets.find((x) => same(x.coords, t.target));
    alert(`MENACE ${t.mission ?? "?"} sur ${p?.name ?? fmt(t.target)} — impact dans ${Math.round((t.arrivesAt - s.now) / 1000)} s${isAttack(t) ? "" : " (ignorée : pas une attaque)"}`);
  }
  const threatened = threatenedPlanetIds(s, threats);
  for (const p of s.planets) {
    const mine = attacks.filter((t) => same(t.target, p.coords));
    const st = saves.get(p.id);
    if (mine.length) {
      // Menace périmée (impact déjà passé mais encore listée) : on ne décolle pas après coup
      if (!st && mine.every((t) => t.arrivesAt <= s.now)) continue;
      const saveAt = Math.min(...mine.map((t) => t.arrivesAt)) - SAVE_BEFORE_MS;
      const recallAt = Math.max(...mine.map((t) => t.arrivesAt)) + RECALL_AFTER_MS;
      if (st) { if (recallAt > st.recallAt) { st.recallAt = recallAt; log("Nouvelle vague sur", p.name, "→ rappel repoussé"); } }
      else if (s.now >= saveAt) await doSave(s, p, mine, recallAt, threatened).catch((e) => alert("SAVE KO", p.name, e.message));
    } else if (st && s.now >= st.recallAt) {
      await doRecall(s, p, st).catch((e) => alert("RECALL KO", p.name, e.message));
    }
  }
  // Une menace disparue avant l'impact (attaquant qui rappelle) : rien à faire, on n'a pas décollé.
  // Si on avait déjà décollé, le rappel se fait à recallAt comme prévu.
}

// ---------- 4. Approvisionnement depuis Père ----------
let lastSupply = 0;
async function supply(s: State, threatened: Set<string>) {
  const pere = s.planets.find((p) => p.id === PERE);
  if (!pere || threatened.has(PERE)) return;
  for (const [pid, want] of Object.entries(SUPPLY)) {
    const p = s.planets.find((x) => x.id === pid);
    if (!p || threatened.has(p.id)) continue; // jamais vers une planète menacée
    if (s.fleets.some((f) => f.mission === "transport" && f.phase === "outbound" && same(f.target?.coords, p.coords))) continue;
    const need = (k: keyof Res) => Math.max(0, Math.min(want[k] ?? 0, p.capacities[k]) - Math.floor(p.resources[k]));
    let cargo: Res = {
      metal: Math.min(need("metal"), Math.floor(pere.resources.metal)),
      crystal: Math.min(need("crystal"), Math.floor(pere.resources.crystal)),
      deuterium: Math.min(need("deuterium"), Math.max(0, Math.floor(pere.resources.deuterium) - DEUT_RESERVE)),
    };
    const total = cargo.metal + cargo.crystal + cargo.deuterium;
    if (total < SUPPLY_MIN_SEND) continue;
    const lc = Math.min(pere.ships.largeCargo ?? 0, Math.ceil(total / CARGO.largeCargo));
    if (!lc) { log("Pas de grand transporteur à Père pour", p.name); continue; }
    if (lc * CARGO.largeCargo < total) cargo = fillCargo({ ...cargo, deuterium: cargo.deuterium + DEUT_RESERVE }, lc * CARGO.largeCargo);
    if (s.fleetSlots.used >= s.fleetSlots.total) { log("SUPPLY : aucun slot libre"); return; }
    const what = `Père → ${p.name} : ${lc} GT · ${resStr(cargo)}`;
    if (!flags.supply) { log(`[OBSERVATION] SUPPLY j'aurais envoyé ${what}`); continue; }
    alert(`SUPPLY ${what}`, await api.sendFleet({ planetId: PERE, mission: "transport", coords: xy(p.coords), ships: { largeCargo: lc }, cargo }));
    pere.ships.largeCargo -= lc; s.fleetSlots.used++;
  }
}

// ---------- 5. Collecte colonies → Père (BetweenLands déborde) ----------
let lastCollect = 0;
async function collect(s: State, threatened: Set<string>) {
  const pere = s.planets.find((p) => p.id === PERE);
  if (!pere || threatened.has(PERE)) return;
  for (const p of s.planets) {
    if (p.id === PERE || threatened.has(p.id)) continue;
    const over = (Object.keys(p.resources) as (keyof Res)[]).some((k) => p.capacities[k] > 0 && p.resources[k] > COLLECT_THRESHOLD * p.capacities[k]);
    if (!over) continue;
    if (s.fleets.some((f) => f.mission === "transport" && f.phase === "outbound" && f.origin?.planetId === p.id && same(f.target?.coords, pere.coords))) continue;
    const excess = (k: keyof Res) => Math.max(0, Math.floor(p.resources[k] - COLLECT_KEEP * p.capacities[k]));
    const want: Res = { metal: excess("metal"), crystal: excess("crystal"), deuterium: Math.max(0, excess("deuterium") - DEUT_RESERVE) };
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
    alert(`COLLECT ${what}`, await api.sendFleet({ planetId: p.id, mission: "transport", coords: xy(pere.coords), ships, cargo }));
    s.fleetSlots.used++;
  }
}

// ---------- 6. Capture de données (formule carburant / distance) ----------
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
  const lines = [
    `Slots ${s.fleetSlots.used}/${s.fleetSlots.total} · ${s.fleets.length} flotte(s) en vol · ${threats.length} menace(s)`,
    `Flags : save ${f.save ? "ARMÉ" : "observation"} · supply ${f.supply ? "on" : "off"} · collect ${f.collect ? "on" : "off"}`,
    `Latence /state ${h.avgLatencyMs} ms · ${h.polls} polls · ${h.errors} erreurs · uptime ${Math.round(h.uptimeMs / 60_000)} min`,
    ...s.planets.map((p) => `• ${p.name} ${fmt(p.coords)} — ${resStr(roundRes(p.resources))}${p.buildQueue ? " 🏗" : ""}${p.shipQueue ? " 🚀" : ""}`),
  ];
  return lines.join("\n");
}
export const roundRes = (r: Res): Res => ({ metal: Math.floor(r.metal), crystal: Math.floor(r.crystal), deuterium: Math.floor(r.deuterium) });
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
  return ts.map((t) => {
    const p = s.planets.find((x) => same(x.coords, t.target));
    return `• ${t.mission ?? "?"} sur ${p?.name ?? fmt(t.target)} — impact dans ${Math.round((t.arrivesAt - s.now) / 1000)} s${isAttack(t) ? "" : " (ignorée)"}`;
  }).join("\n");
}

/** Prochain réveil : le poll normal (avec jitter), ou plus tôt si une échéance (décollage / rappel) tombe avant.
 *  Pas de poll rapide : un seul appel supplémentaire, calé sur l'échéance en horloge serveur. */
function pollDelay(s: State, threats: Threat[]): number {
  const deadlines = [
    ...threats.filter((t) => isAttack(t) && !saves.has(planetIdAt(s, t.target) ?? "")).map((t) => t.arrivesAt - SAVE_BEFORE_MS),
    ...[...saves.values()].map((st) => st.recallAt),
  ].filter((d) => d > s.now);
  const normal = POLL_MS * (0.8 + Math.random() * 0.4);
  const next = deadlines.length ? Math.min(...deadlines) - s.now : Infinity;
  return Math.max(MIN_SLEEP_MS, Math.min(normal, next));
}
const planetIdAt = (s: State, c: Coords) => s.planets.find((p) => same(p.coords, c))?.id;

// ---------- Boucle ----------
export async function watch() {
  log("watch démarré", getFlags());
  for (;;) {
    try {
      const s = await getState();
      sampleFleets(s);
      const threats = parseThreats(s);
      await fleetSaveTick(s, threats);
      const threatened = threatenedPlanetIds(s, threats);
      if (Date.now() - lastSupply > SUPPLY_EVERY_MS) { lastSupply = Date.now(); await supply(s, threatened).catch((e) => alert("SUPPLY KO", e.message)); }
      if (Date.now() - lastCollect > COLLECT_EVERY_MS) { lastCollect = Date.now(); await collect(s, threatened).catch((e) => alert("COLLECT KO", e.message)); }
      await sleep(pollDelay(s, threats));
    } catch (e: any) {
      health.errors++; health.lastError = e.message;
      log("ERR", e.message);
      await sleep(10_000);
    }
  }
}

// ---------- CLI ----------
const isMain = /bot\.ts$/.test(process.argv[1] ?? "");
if (isMain) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "attack") attack(a, b).then((r) => log(r)).catch((e) => { log(e.message); process.exit(1); });
  else if (cmd === "watch") watch();
  else if (cmd === "status") getState().then((s) => console.log(statusSummary(s))).catch((e) => { log(e.message); process.exit(1); });
  else console.log("Usage : attack <preset> <système:position> | watch | status");
}
