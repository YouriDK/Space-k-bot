// Flotte automatique (/autofleet) : un type de vaisseau par planète, construit sur son chantier avec le SURPLUS de Père uniquement.
// Plancher automatique de Père (les bâtiments passent avant la flotte), par ressource : le maximum, sur les planètes à autobuild activé,
// du coût de leur besoin courant (autobuild.ts) et, pour Père, de son prochain objectif non atteint ; plus le coût de Graviton s'il est
// visible et pas encore lancé (Graviton auto allumé) ; plus DEUT_RESERVE sur le deut. Surplus = stock de Père − plancher (jamais négatif).
// Rien tant qu'un financement de bâtiment (buildfund.ts) attend encore des ressources de Père. Une décision toutes les 5 min au plus,
// UN lot par décision, pour la planète activée au chantier libre servie le moins récemment. Lot limité par le surplus, la soute à quai
// sur Père (hors Père), `max` (nombre visé à quai) et ~2 h de chantier ; pas de micro-lot (< 30 min de chantier sauf si `max` le limite).
// Lancement via planFleetBuild / startFleetBuild (transport depuis Père puis lancement à l'arrivée ; direct sur Père).
// Réglages persistés dans auto-fleet.json, créé au premier chargement avec les 5 planètes ACTIVÉES (types choisis le 05/10/2026, sans max).
// /pause suspend tout ; rien si Père ou la planète est menacée, ni sur une planète réservée.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Planet, Res, State } from "./spacek-client.ts";
import { PERE, CARGO, DEUT_RESERVE, alert, etaStr, fmtNum, isPaused, log, num } from "./core.ts";
import { buildCtx, gravitonOn, loadPlan, nextBuilding, nextObjective, planetPlan } from "./autobuild.ts";
import { fleetBuildOrders, planFleetBuild, shipChoices, shipName, startFleetBuild } from "./fleetbuild.ts";
import { fundNeedsPere } from "./buildfund.ts";
import { researchChoices } from "./nextbuild.ts";
import { planetReserved, reservedWhy } from "./reserve.ts";
import { parseThreats, threatenedPlanetIds } from "./threats.ts";

// ================= CONFIG =================
export const AUTOFLEET_EVERY_MS = num("AUTOFLEET_EVERY_MIN", 5) * 60_000; // une décision toutes les N min au plus
export const AUTOFLEET_LOT_MS = num("AUTOFLEET_LOT_H", 2) * 3_600_000;    // durée de chantier visée par lot
export const AUTOFLEET_MIN_MS = num("AUTOFLEET_MIN_LOT_MIN", 30) * 60_000; // en dessous : micro-lot, on attend
const FILE = "auto-fleet.json";
const DEFAULTS: Record<string, string> = { pl_7vb: "largeCargo", pl_4z8: "cruiser", pl_rn: "destroyer", pl_402: "pathfinder", [PERE]: "battleship" };
// ==========================================

const RES_KEYS: (keyof Res)[] = ["metal", "crystal", "deuterium"];
const resFmt = (r: Res) => `M ${fmtNum(r.metal)} · C ${fmtNum(r.crystal)} · D ${fmtNum(r.deuterium)}`;

// ---------- Réglages (auto-fleet.json) ----------
export type AutoFleetPlanet = { enabled: boolean; key: string; max?: number }; // max = nombre total visé à quai (absent = illimité)
let conf: Record<string, AutoFleetPlanet> = {};
let lastServed: Record<string, number> = {};
export function loadAutoFleet() {
  try {
    if (!existsSync(FILE)) {
      conf = Object.fromEntries(Object.entries(DEFAULTS).map(([id, key]) => [id, { enabled: true, key }]));
      lastServed = {};
      persist(); log("auto-fleet.json créé");
      return;
    }
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    conf = Object.fromEntries(Object.entries(raw?.planets ?? {}).filter(([, v]: [string, any]) => typeof v?.key === "string")
      .map(([id, v]: [string, any]) => [id, { enabled: v.enabled === true, key: v.key, ...(Number.isInteger(v.max) && v.max >= 0 ? { max: v.max } : {}) }]));
    lastServed = raw?.lastServed ?? {};
  } catch (e: any) { console.error("auto-fleet.json illisible :", e.message); }
}
function persist() {
  try { writeFileSync(`${FILE}.tmp`, JSON.stringify({ planets: conf, lastServed }, null, 2)); renameSync(`${FILE}.tmp`, FILE); }
  catch (e: any) { log("auto-fleet.json KO :", e.message); }
}
loadAutoFleet();
export const getAutoFleet = (planetId: string): AutoFleetPlanet | undefined => (conf[planetId] ? { ...conf[planetId] } : undefined);
export function setAutoFleetEnabled(planetId: string, v: boolean): AutoFleetPlanet {
  const c = conf[planetId];
  if (!c) throw new Error("Aucun vaisseau choisi pour cette planète : /autofleet <planète> <vaisseau>");
  conf[planetId] = { ...c, enabled: v }; warned.delete(planetId); persist();
  log("AUTOFLEET", planetId, "=", v);
  return { ...conf[planetId] };
}
/** Active/désactive d'un coup toutes les planètes qui ont un vaisseau choisi ; renvoie celles dont l'état a changé. */
export function setAutoFleetAll(v: boolean): string[] {
  const changed = Object.keys(conf).filter((id) => conf[id].enabled !== v);
  for (const id of changed) { conf[id] = { ...conf[id], enabled: v }; warned.delete(id); }
  if (changed.length) { persist(); log("AUTOFLEET *", "=", v, changed.join(",")); }
  return changed;
}
/** Change le type (refusé si inconnu ou verrouillé sur CE chantier) ; `max` : nombre visé, null = illimité, undefined = inchangé. */
export function setAutoFleetKey(p: Planet, key: string, max?: number | null): AutoFleetPlanet {
  const c = shipChoices(p).find((x) => x.key === key);
  if (!c) throw new Error(`${shipName(key)} : inconnu du chantier de ${p.name} (${shipChoices(p).filter((x) => !x.locked).map((x) => x.key).join(", ") || "aucune option"})`);
  if (c.locked) throw new Error(`🔒 ${c.name} verrouillé sur ${p.name} (chantier niv. ${p.buildings?.shipyard ?? 0})`);
  const prev = conf[p.id];
  const next: AutoFleetPlanet = { enabled: prev?.enabled ?? true, key };
  const m = max === undefined ? (prev?.key === key ? prev.max : undefined) : max ?? undefined;
  if (m != null) next.max = m;
  conf[p.id] = next; warned.delete(p.id); persist();
  log("AUTOFLEET", p.name, key, m ?? "illimité");
  return { ...next };
}
export function setAutoFleetMax(planetId: string, max: number | null): AutoFleetPlanet {
  const c = conf[planetId];
  if (!c) throw new Error("Aucun vaisseau choisi pour cette planète : /autofleet <planète> <vaisseau>");
  const { max: _, ...rest } = c;
  conf[planetId] = max == null ? rest : { ...rest, max }; warned.delete(planetId); persist();
  return { ...conf[planetId] };
}

// ---------- Calcul pur ----------
/** Plancher de Père (par ressource) et surplus disponible pour la flotte, avec le détail des postes retenus. */
export function pereFloor(s: State): { floor: Res; surplus: Res; parts: string[] } {
  const pl = loadPlan(s);
  const ctx = buildCtx(s);
  const floor: Res = { metal: 0, crystal: 0, deuterium: 0 };
  const parts: string[] = [];
  const take = (c: { metal: number; crystal: number; deuterium: number }) => { for (const k of RES_KEYS) floor[k] = Math.max(floor[k], Math.ceil(c[k])); };
  for (const p of s.planets) {
    const pp = planetPlan(pl, p.id);
    if (!pp.enabled) continue;
    const c = p.id === PERE ? nextObjective(p, pp) : nextBuilding(p, pp, ctx).besoin;
    if (!c) continue;
    // Ce bâtiment est déjà en construction : l'étape à payer ensuite est le niveau d'après, environ le double [DÉDUIT des coûts relevés]
    const enCours = p.buildQueue?.key === c.key;
    take(enCours ? { metal: c.cost.metal * 2, crystal: c.cost.crystal * 2, deuterium: c.cost.deuterium * 2 } : c.cost);
    parts.push(`${p.name} ${c.name} ${c.next + (enCours ? 1 : 0)}`);
  }
  // Graviton : visible (labo 12) et pas encore lancé [DÉDUIT : clé du codex]
  const rq = s.player.researchQueue;
  const g = researchChoices(s).find((x) => x.key === "graviton");
  if (g && gravitonOn(pl) && !(s.player.research?.graviton ?? 0) && rq?.key !== "graviton") {
    for (const k of RES_KEYS) floor[k] += Math.ceil(g.cost?.[k] ?? 0);
    parts.push("Graviton");
  }
  floor.deuterium += DEUT_RESERVE;
  const pere = s.planets.find((p) => p.id === PERE);
  const surplus: Res = { metal: 0, crystal: 0, deuterium: 0 };
  if (pere) for (const k of RES_KEYS) surplus[k] = Math.max(0, Math.floor(pere.resources[k]) - floor[k]);
  return { floor, surplus, parts };
}
export type Lot = { qty: number; why?: string; limits: Record<string, number> };
/** Taille du lot pour une planète (aucun POST) : min(surplus, soute à quai sur Père hors Père, max, ~2 h de chantier) ; micro-lot → 0. */
export function autoFleetLot(s: State, p: Planet, c: AutoFleetPlanet, surplus: Res): Lot {
  const pere = s.planets.find((x) => x.id === PERE);
  const sc = shipChoices(p).find((x) => x.key === c.key);
  if (!sc) return { qty: 0, why: `${shipName(c.key)} inconnu du chantier`, limits: {} };
  if (sc.locked) return { qty: 0, why: `${sc.name} verrouillé sur ce chantier`, limits: {} };
  const unit = sc.cost.metal + sc.cost.crystal + sc.cost.deuterium;
  const inf = Number.POSITIVE_INFINITY;
  const parRes = Math.min(...RES_KEYS.filter((k) => sc.cost[k] > 0).map((k) => Math.floor(surplus[k] / sc.cost[k])));
  const quai = pere ? (pere.ships.largeCargo ?? 0) * CARGO.largeCargo + (pere.ships.smallCargo ?? 0) * CARGO.smallCargo : 0;
  const limits: Record<string, number> = {
    surplus: Number.isFinite(parRes) ? parRes : inf,
    soute: p.id === PERE || !unit ? inf : Math.floor(quai / unit),
    max: c.max != null ? Math.max(0, c.max - (p.ships[c.key] ?? 0)) : inf,
    duree: sc.unitMs > 0 ? Math.max(1, Math.floor(AUTOFLEET_LOT_MS / sc.unitMs)) : inf, // un vaisseau plus long que 2 h reste possible seul
  };
  const qty = Math.min(...Object.values(limits));
  if (!Number.isFinite(qty)) return { qty: 0, why: "quantité non bornée (coût et durée nuls ?)", limits };
  if (qty < 1) {
    const by = limits.max < 1 ? `max atteint (${p.ships[c.key] ?? 0}/${c.max})` : limits.surplus < 1 ? "surplus de Père insuffisant pour 1 vaisseau" : "pas assez de transporteurs à quai sur Père";
    return { qty: 0, why: by, limits };
  }
  if (qty * sc.unitMs < AUTOFLEET_MIN_MS && qty < limits.max) {
    const by = limits.surplus <= qty ? "surplus" : limits.soute <= qty ? "soute" : "?";
    return { qty: 0, why: `micro-lot : ${qty} ${sc.name} = ${etaStr(qty * sc.unitMs)} de chantier (< ${etaStr(AUTOFLEET_MIN_MS)}, limité par ${by})`, limits };
  }
  return { qty, limits };
}
/** Chantier libre pour la flotte auto, sinon la raison. */
function blocage(s: State, p: Planet, threatened: Set<string>): string | null {
  if (p.shipQueue) return `chantier occupé (${p.shipQueue.remaining ?? "?"} ${shipName(p.shipQueue.key)} en file)`;
  if (p.shipyardBusy) return "chantier occupé";
  if (p.buildQueue?.key === "shipyard") return "chantier en cours d'amélioration";
  if (fleetBuildOrders().some((o) => o.planetId === p.id)) return "commande /fleetbuild en attente";
  if (planetReserved(p.id)) return reservedWhy(p.id);
  if (threatened.has(p.id)) return "planète menacée";
  if ((p.buildings?.shipyard ?? 0) < 1) return "pas de chantier";
  return null;
}

// ---------- Tick ----------
let lastDecision = 0;
const warned = new Map<string, string>(); // planetId (ou "*") → dernière raison signalée
export async function autoFleetTick(s: State, threatened: Set<string>) {
  if (isPaused()) return;
  if (Date.now() - lastDecision < AUTOFLEET_EVERY_MS) return;
  const actives = s.planets.filter((p) => conf[p.id]?.enabled);
  if (!actives.length) return;
  lastDecision = Date.now();
  if (threatened.has(PERE)) return; // jamais de dépense ni de transport depuis Père menacé
  if (fundNeedsPere(s)) return;     // les bâtiments d'abord
  const { surplus } = pereFloor(s);
  const order = [...actives].sort((a, b) => (lastServed[a.id] ?? 0) - (lastServed[b.id] ?? 0));
  for (const p of order) {
    const c = conf[p.id];
    if (blocage(s, p, threatened)) continue;
    const lot = autoFleetLot(s, p, c, surplus);
    if (!lot.qty) continue;
    try {
      const plan = planFleetBuild(s, p, c.key, lot.qty);
      const txt = await startFleetBuild(s, plan);
      lastServed[p.id] = Date.now(); persist();
      warned.delete(p.id);
      const reste: Res = { metal: surplus.metal - plan.cost.metal, crystal: surplus.crystal - plan.cost.crystal, deuterium: surplus.deuterium - plan.cost.deuterium };
      alert(`🤖 Flotte auto ${p.name} : ${lot.qty} ${plan.name} · coût ${resFmt(plan.cost)} · ${etaStr(plan.durationMs)} de chantier\nSurplus de Père restant : ${resFmt(reste)}\n${txt}`);
      log("AUTOFLEET", p.name, c.key, lot.qty);
    } catch (e: any) {
      const msg = String(e.message).slice(0, 200);
      const reason = msg.replace(/\d[\d\s ,.]*/g, "#"); // une alerte par raison, pas une par chiffre
      if (warned.get(p.id) !== reason) { warned.set(p.id, reason); alert(`⏳ Flotte auto ${p.name} : ${lot.qty} ${shipName(c.key)} non lancés — ${msg}`); }
      log("AUTOFLEET KO", p.name, c.key, lot.qty, msg);
    }
    return; // UN lot par décision
  }
}

// ---------- Résumé Telegram ----------
export function autoFleetSummary(s: State): string {
  const threatened = threatenedPlanetIds(s, parseThreats(s));
  const { floor, surplus, parts } = pereFloor(s);
  const fund = fundNeedsPere(s);
  const lines = s.planets.map((p) => {
    const c = conf[p.id];
    if (!c) return `• ${p.name} : aucun vaisseau choisi (/autofleet ${p.name} <vaisseau>)`;
    const quai = p.ships[c.key] ?? 0;
    const file = p.shipQueue ? `${p.shipQueue.remaining ?? "?"} ${shipName(p.shipQueue.key)}` : "rien";
    const b = blocage(s, p, threatened);
    const lot = b ? null : autoFleetLot(s, p, c, surplus);
    const next = b ? `bloqué : ${b}` : fund ? `en attente : ${fund}` : lot!.qty ? `prochain lot : ${lot!.qty} ${shipName(c.key)}` : `rien : ${lot!.why}`;
    return `• ${p.name} [${c.enabled ? "on" : "off"}] ${shipName(c.key)} · à quai ${fmtNum(quai)}${c.max != null ? `/${fmtNum(c.max)}` : " (illimité)"} · en file ${file}\n  ${next}`;
  });
  const due = Math.max(0, lastDecision + AUTOFLEET_EVERY_MS - Date.now());
  return [
    `🤖 Flotte auto${isPaused() ? " ⏸ EN PAUSE (/resume)" : ""} · une décision toutes les ${etaStr(AUTOFLEET_EVERY_MS)} (prochaine ${due ? `dans ${etaStr(due)}` : "au prochain passage"}) · lots ≈ ${etaStr(AUTOFLEET_LOT_MS)} de chantier`,
    `Plancher de Père : ${resFmt(floor)}${parts.length ? ` (${parts.join(", ")} + réserve deut)` : " (réserve deut)"}`,
    `Surplus pour la flotte : ${resFmt(surplus)}`,
    ...lines,
  ].join("\n");
}
