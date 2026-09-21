// Galaxie et scans : planètes d'un joueur (leaderboard + /galaxy?system=N, cache 30 min, relevé initial
// galaxy-snapshot.json), et scan « 15 sondes sur chaque planète du joueur en même temps » depuis Père.
import { existsSync, readFileSync } from "node:fs";
import type { GalaxySystem, LeaderboardRow, State } from "./spacek-client.ts";
import { PERE, api, fmt, log, num, pere, prepareFleet, sendFleet, sleep, type FleetPlan } from "./core.ts";

const GALAXY_CACHE_MS = 30 * 60_000;
const SCAN_PROBES = num("SCAN_PROBES", 15); // sondes par planète visée
const SNAPSHOT = "galaxy-snapshot.json";      // relevé complet (script sweep) : cache initial des planètes par joueur

const galaxyCache = new Map<number, { at: number; sys: GalaxySystem }>();
export async function galaxySystemCached(n: number) {
  const c = galaxyCache.get(n);
  if (c && Date.now() - c.at < GALAXY_CACHE_MS) return c.sys;
  const sys = await api.galaxySystem(n);
  galaxyCache.set(n, { at: Date.now(), sys });
  await sleep(150); // appels espacés : pas de rafale
  return sys;
}

type SnapPlanet = { system: number; position: number; name: string; ownerName: string; ownerId: string };
let snapshot: { at: string; planets: SnapPlanet[]; leaderboard: LeaderboardRow[] } | null = null;
function loadSnapshot() {
  if (snapshot || !existsSync(SNAPSHOT)) return snapshot;
  try { snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8")); } catch (e: any) { log("galaxy-snapshot.json illisible :", e.message); }
  return snapshot;
}

export type PlayerPlanet = { system: number; position: number; name: string; moon: boolean; vacances: boolean; protection: boolean; debris?: { metal: number; crystal: number } | null };
export type PlayerInfo = { row?: LeaderboardRow; rank?: number; name: string; planets: PlayerPlanet[] };

const toPlayerPlanet = (sys: GalaxySystem, position: number): PlayerPlanet | undefined => {
  const sl = sys.slots.find((x) => x.position === position);
  if (!sl?.planet) return undefined;
  return { system: sys.system, position, name: sl.planet.name, moon: !!sl.planet.moon, vacances: sl.planet.vacances, protection: !!sl.planet.protection, debris: sl.debris };
};

/** Toutes les planètes d'un joueur (nom insensible à la casse) + sa ligne de classement.
 *  1) le relevé initial donne les systèmes à vérifier (peu d'appels) ; 2) si le compte ne colle pas au classement, parcours complet. */
export async function findPlayer(query: string): Promise<PlayerInfo> {
  const q = query.toLowerCase().trim();
  const { rows } = await api.leaderboard();
  const idx = rows.findIndex((r) => r.name.toLowerCase() === q);
  const row = idx >= 0 ? rows[idx] : rows.find((r) => r.name.toLowerCase().includes(q));
  const name = (row?.name ?? query);
  const lname = name.toLowerCase();
  const planets: PlayerPlanet[] = [];
  const seen = new Set<string>();
  const push = (p?: PlayerPlanet) => { if (p && !seen.has(fmt(p))) { seen.add(fmt(p)); planets.push(p); } };

  // 1) systèmes connus par le relevé
  const snap = loadSnapshot();
  const known = snap?.planets.filter((p) => p.ownerName.toLowerCase() === lname) ?? [];
  for (const sysNo of [...new Set(known.map((p) => p.system))]) {
    const sys = await galaxySystemCached(sysNo);
    for (const sl of sys.slots) if (sl.planet && sl.planet.ownerName.toLowerCase() === lname) push(toPlayerPlanet(sys, sl.position));
  }
  // 2) parcours complet si le compte diffère du classement (colonisation / perte depuis le relevé)
  if (!row || planets.length !== row.planets) {
    const carte = await api.galaxy();
    for (const sy of carte.systemes.filter((x) => x.planetes > 0)) {
      const sys = await galaxySystemCached(sy.system);
      for (const sl of sys.slots) if (sl.planet && sl.planet.ownerName.toLowerCase() === lname) push(toPlayerPlanet(sys, sl.position));
      if (row && planets.length >= row.planets) break;
    }
  }
  planets.sort((a, b) => a.system - b.system || a.position - b.position);
  return { row, rank: idx >= 0 ? idx + 1 : undefined, name, planets };
}

export function playerSummary(r: PlayerInfo, query: string): string {
  const head = r.row
    ? `${r.row.name}${r.rank ? ` — #${r.rank}` : ""} · ${r.row.planets} planète(s) · puissance ${r.row.combatPower.toLocaleString("fr-FR")} · dév. ${r.row.development}${r.row.titre ? ` · ${r.row.titre}` : ""}`
    : `Joueur « ${query} » absent du classement`;
  if (!r.planets.length) return `${head}\nAucune planète trouvée dans la galaxie.`;
  return [head, ...r.planets.map((p) =>
    `• ${fmt(p)} ${p.name}${p.moon ? " 🌙" : ""}${p.vacances ? " (vacances)" : ""}${p.protection ? " 🛡 protégé" : ""}${p.debris ? ` · débris M ${p.debris.metal} C ${p.debris.crystal}` : ""}`)].join("\n");
}

// ---------- Scan d'un joueur : une flotte de sondes par planète, toutes en même temps ----------
export type ScanPlan = { player: PlayerInfo; plans: FleetPlan[]; summary: string };
export async function planScan(s: State, query: string): Promise<ScanPlan> {
  const player = await findPlayer(query);
  if (!player.planets.length) throw new Error(`Aucune planète trouvée pour « ${query} »`);
  const p = pere(s);
  const probes = p.ships.espionageProbe ?? 0;
  const n = player.planets.length;
  let perPlanet = SCAN_PROBES;
  const notes: string[] = [];
  if (probes < SCAN_PROBES * n) {
    perPlanet = Math.floor(probes / n); // pas assez : on divise les sondes disponibles par le nombre de planètes
    if (perPlanet < 1) throw new Error(`Seulement ${probes} sonde(s) sur Père pour ${n} planètes`);
    notes.push(`⚠️ ${probes} sondes dispo < ${SCAN_PROBES} × ${n} → ${perPlanet} par planète`);
  }
  const freeSlots = s.fleetSlots.total - s.fleetSlots.used;
  let targets = player.planets;
  if (freeSlots < n) {
    if (freeSlots < 1) throw new Error(`Aucun slot de flotte libre (${s.fleetSlots.used}/${s.fleetSlots.total})`);
    targets = player.planets.slice(0, freeSlots);
    notes.push(`⚠️ ${freeSlots} slot(s) libre(s) sur ${n} planètes → seules les ${freeSlots} premières seront sondées`);
  }
  const plans = targets.map((t, i) =>
    prepareFleet(s, { from: PERE, mission: "espionage", coords: t, ships: { espionageProbe: perPlanet }, slotsReserved: i }));
  const summary = [
    `🔍 Scan de ${player.name} : ${perPlanet} sondes × ${targets.length} planète(s) depuis ${p.name}`,
    ...targets.map((t) => `• ${fmt(t)} ${t.name}${t.vacances ? " (vacances)" : ""}${t.protection ? " 🛡" : ""}`),
    ...notes,
  ].join("\n");
  return { player, plans, summary };
}
/** Envoie toutes les flottes du scan ; résultat par planète (ok / erreur), sans s'arrêter à la première erreur. */
export async function runScan(sc: ScanPlan): Promise<string> {
  const out: string[] = [];
  for (const plan of sc.plans) {
    try { await sendFleet(plan); out.push(`✅ ${fmt(plan.payload.coords)}`); }
    catch (e: any) { out.push(`❌ ${fmt(plan.payload.coords)} : ${e.message.slice(0, 120)}`); }
  }
  return out.join("\n");
}
