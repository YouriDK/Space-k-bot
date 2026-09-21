// Noyau partagé par tous les modules (bot, presets, scan, expedition, notify, autobuild, telegram) :
// client API, flags, log/notification, santé, helpers de flotte. Aucune logique de boucle ici.
import { appendFileSync } from "node:fs";
import { SpaceK, type Coords, type Mission, type Res, type State, planetByName } from "./spacek-client.ts";

export const PERE = "pl_2w";

export function num(k: string, d: number) { const v = Number(process.env[k]); return Number.isFinite(v) && process.env[k] ? v : d; }
export function bool(k: string, d = false) { const v = process.env[k]; return v == null || v === "" ? d : /^(1|true|on|yes)$/i.test(v); }

export const DEUT_RESERVE = num("DEUT_RESERVE", 5_000); // deut laissé pour le carburant (conso inconnue → à ajuster)

// Soutes de base (vaisseaux.md). Satellites : ne volent jamais.
export const CARGO: Record<string, number> = {
  smallCargo: 5_000, largeCargo: 25_000, lightFighter: 50, heavyFighter: 100, cruiser: 800,
  battleship: 1_500, colonyShip: 7_500, espionageProbe: 5, recycler: 20_000, pathfinder: 10_000,
  bomber: 500, destroyer: 2_000, battlecruiser: 750, deathStar: 1_000_000,
};
export const NEVER_FLY = new Set(["solarSatellite"]);
// Noms affichés (vaisseaux.md) — les clés API restent en anglais
export const SHIP_FR: Record<string, string> = {
  smallCargo: "PT", largeCargo: "GT", lightFighter: "chasseurs légers", heavyFighter: "chasseurs lourds", cruiser: "croiseurs",
  battleship: "VB", colonyShip: "colonisateurs", espionageProbe: "sondes", recycler: "recycleurs", pathfinder: "éclaireurs",
  bomber: "bombardiers", destroyer: "destructeurs", battlecruiser: "traqueurs", deathStar: "EDLM", solarSatellite: "satellites",
};

// ---------- Flags (modifiables à chaud depuis Telegram) ----------
export type Flags = { save: boolean; supply: boolean; collect: boolean; autobuild: boolean };
export const flags: Flags = {
  save: bool("SAVE_ARMED"), supply: bool("SUPPLY_ENABLED"), collect: bool("COLLECT_ENABLED"), autobuild: bool("AUTOBUILD_ENABLED"),
};
let pausedFrom: Flags | null = null;
export const getFlags = (): Flags => ({ ...flags });
export function setFlag(k: keyof Flags, v: boolean) { flags[k] = v; log("FLAG", k, "=", v); return getFlags(); }
export function pause() { if (!pausedFrom) pausedFrom = { ...flags }; (Object.keys(flags) as (keyof Flags)[]).forEach((k) => (flags[k] = false)); log("PAUSE"); return getFlags(); }
export function resume() { if (pausedFrom) Object.assign(flags, pausedFrom); pausedFrom = null; log("RESUME", flags); return getFlags(); }
export const flagsStr = (f: Flags) =>
  `save ${f.save ? "ARMÉ 🔴" : "observation"} · supply ${f.supply ? "on" : "off"} · collect ${f.collect ? "on" : "off"} · autobuild ${f.autobuild ? "on" : "off"}`;

// ---------- Outils ----------
export const api = new SpaceK();
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const xy = (c: any): Coords => ({ system: c.system, position: c.position });
export const same = (a: any, b: any) => !!a && !!b && a.system === b.system && a.position === b.position;
export const fmt = (c: Coords) => `${c.system}:${c.position}`;
export const log = (...a: any[]) => console.log(new Date().toISOString(), ...a);
let notify: ((msg: string) => void) | null = null;
export const setNotify = (fn: (msg: string) => void) => { notify = fn; };
export const alert = (...a: any[]) => { log(...a); notify?.(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
export const shipsStr = (s: Record<string, number>) => Object.entries(s).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${SHIP_FR[k] ?? k}`).join(", ") || "—";
export const resStr = (r: Res) => `M ${r.metal} · C ${r.crystal} · D ${r.deuterium}`;
export const roundRes = (r: Res): Res => ({ metal: Math.floor(r.metal), crystal: Math.floor(r.crystal), deuterium: Math.floor(r.deuterium) });
export const fmtNum = (n: number) => Math.round(n).toLocaleString("fr-FR");
export const fmtDur = (ms: number) => { const m = Math.round(ms / 60_000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`; };
export function appendJsonl(file: string, obj: object) { try { appendFileSync(file, JSON.stringify(obj) + "\n"); } catch (e: any) { log("jsonl KO", file, e.message); } }
export function parseCoords(pos: string): Coords {
  const m = pos.match(/^(\d+):(\d+)$/);
  if (!m) throw new Error(`Coordonnées invalides : ${pos} (attendu système:position)`);
  return { system: +m[1], position: +m[2] };
}
export function planetOrThrow(s: State, q: string) { const p = planetByName(s, q); if (!p) throw new Error(`Planète inconnue : ${q}`); return p; }
export const pere = (s: State) => planetOrThrow(s, PERE);

// ---------- Santé (pour /status et le heartbeat) ----------
const health = { startedAt: Date.now(), lastPollAt: 0, polls: 0, errors: 0, lastError: "", latencies: [] as number[] };
export function getHealth() {
  const l = health.latencies;
  return { ...health, avgLatencyMs: l.length ? Math.round(l.reduce((a, b) => a + b, 0) / l.length) : 0, uptimeMs: Date.now() - health.startedAt };
}
export function recordError(msg: string) { health.errors++; health.lastError = msg; }
export async function getState(): Promise<State> {
  const t0 = Date.now();
  const s = await api.state();
  health.latencies.push(Date.now() - t0); if (health.latencies.length > 20) health.latencies.shift();
  health.lastPollAt = Date.now(); health.polls++;
  return s;
}

// ---------- Flottes : capacité, remplissage, plan + envoi (exécution séparée pour la confirmation Telegram) ----------
export const capacity = (ships: Record<string, number>) => Object.entries(ships).reduce((a, [k, n]) => a + (CARGO[k] ?? 0) * n, 0);
/** Remplit une soute par priorité deut > cristal > métal, en gardant `keepDeut` sur place. */
export function fillCargo(r: Res, cap: number, keepDeut = DEUT_RESERVE): Res {
  const d = Math.min(Math.max(0, Math.floor(r.deuterium) - keepDeut), cap); cap -= d;
  const c = Math.min(Math.floor(r.crystal), cap); cap -= c;
  const m = Math.min(Math.floor(r.metal), cap);
  return { metal: m, crystal: c, deuterium: d };
}
export type FleetPayload = {
  planetId: string; mission: Mission; coords: Coords; ships: Record<string, number>; cargo: Res; speedPercent: number;
  rallier?: boolean; heures?: number;
};
export type FleetPlan = { payload: FleetPayload; summary: string };
export function prepareFleet(s: State, o: {
  from: string; mission: Mission; coords: Coords; ships: Record<string, number>; cargo?: Partial<Res>; speedPercent?: number;
  rallier?: boolean; heures?: number; label?: string; slotsReserved?: number;
}): FleetPlan {
  const p = planetOrThrow(s, o.from);
  const ships = Object.fromEntries(Object.entries(o.ships).filter(([, n]) => n > 0));
  if (!Object.keys(ships).length) throw new Error("Aucun vaisseau");
  const manque = Object.entries(ships).filter(([k, n]) => (p.ships[k] ?? 0) < n);
  if (manque.length) throw new Error(`Manque sur ${p.name} : ` + manque.map(([k, n]) => `${k} ${p.ships[k] ?? 0}/${n}`).join(", "));
  if (s.fleetSlots.used + (o.slotsReserved ?? 0) >= s.fleetSlots.total) throw new Error(`Aucun slot de flotte libre (${s.fleetSlots.used}/${s.fleetSlots.total})`);
  const cargo: Res = { metal: 0, crystal: 0, deuterium: 0, ...o.cargo };
  const cap = capacity(ships);
  const total = cargo.metal + cargo.crystal + cargo.deuterium;
  if (total > cap) throw new Error(`Soute insuffisante : ${total} > ${cap}`);
  (Object.keys(cargo) as (keyof Res)[]).forEach((k) => { if (cargo[k] > Math.floor(p.resources[k])) throw new Error(`Pas assez de ${k} sur ${p.name} (${Math.floor(p.resources[k])})`); });
  const payload: FleetPayload = {
    planetId: p.id, mission: o.mission, coords: xy(o.coords), ships, cargo, speedPercent: o.speedPercent ?? 100,
    ...(o.rallier ? { rallier: true } : {}), ...(o.heures != null ? { heures: o.heures } : {}),
  };
  const dest = s.planets.find((x) => same(x.coords, payload.coords));
  const summary = [
    `${o.label ?? o.mission} depuis ${p.name} (${fmt(p.coords)}) → ${fmt(payload.coords)}${dest ? ` (${dest.name})` : ""}`,
    `Vaisseaux : ${shipsStr(ships)}`,
    total ? `Cargo : ${resStr(cargo)} / soute ${fmtNum(cap)}` : `Cargo : vide (soute ${fmtNum(cap)})`,
    `Vitesse ${payload.speedPercent} %${payload.rallier ? " · attendre l'allié ✔" : ""}${payload.heures != null ? ` · ${payload.heures} h` : ""} · slots ${s.fleetSlots.used}/${s.fleetSlots.total}`,
  ].join("\n");
  return { payload, summary };
}
export async function sendFleet(plan: FleetPlan) {
  const r = await api.sendFleet(plan.payload);
  log("FLEET", plan.payload.mission, plan.payload.planetId, "→", fmt(plan.payload.coords), r);
  return r;
}
