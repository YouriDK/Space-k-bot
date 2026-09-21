// Auto-construction : quand la file de construction d'une planète est vide, lance le premier bâtiment
// de sa liste de priorités (build-plan.json) qui est finançable. Flag global `autobuild` + `enabled` par planète.
// build-plan.json est rechargé dès qu'il change sur le disque (édition à la main sans redémarrer).
//   { "pl_2w": { "enabled": false, "keepEnergyPositive": true, "skipUnaffordable": false,
//                "priorities": [ { "key": "metalMine", "max": 25 }, { "key": "solarPlant" } ] }, ... }
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { Planet, State } from "./spacek-client.ts";
import { alert, api, flags, fmtDur, fmtNum, log, resStr } from "./core.ts";

const PLAN_FILE = "build-plan.json";
const DECIDE_EVERY_MS = 60_000; // au plus une décision par planète par minute

export type Priority = { key: string; max?: number };
export type PlanetPlan = { enabled: boolean; keepEnergyPositive?: boolean; skipUnaffordable?: boolean; priorities: Priority[] };
export type BuildPlan = Record<string, PlanetPlan>;

// Les 12 bâtiments vus dans buildOptions le 21/09 (nom affiché = buildOptions[].name)
export const BUILDING_KEYS = [
  "metalMine", "crystalMine", "deuteriumSynthesizer", "solarPlant", "fusionPlant",
  "metalStorage", "crystalStorage", "deuteriumStorage", "robotFactory", "shipyard", "missileSilo", "researchLab",
];

let plan: BuildPlan = {};
let planMtime = 0;
const lastDecision = new Map<string, number>();

function defaultPlan(s: State): BuildPlan {
  return Object.fromEntries(s.planets.map((p) => [p.id, {
    enabled: false, keepEnergyPositive: true, skipUnaffordable: false,
    priorities: [{ key: "metalMine", max: 25 }, { key: "crystalMine", max: 22 }, { key: "deuteriumSynthesizer", max: 20 }, { key: "solarPlant" }],
  }]));
}
/** Recharge build-plan.json s'il a changé ; le crée avec un exemple (tout désactivé) s'il n'existe pas. */
export function loadPlan(s?: State): BuildPlan {
  if (!existsSync(PLAN_FILE)) {
    if (s) { plan = defaultPlan(s); writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2)); log("build-plan.json créé (exemple, tout désactivé)"); }
    return plan;
  }
  const m = statSync(PLAN_FILE).mtimeMs;
  if (m !== planMtime) {
    try { plan = JSON.parse(readFileSync(PLAN_FILE, "utf8")); planMtime = m; log("build-plan.json rechargé"); }
    catch (e: any) { log("build-plan.json invalide :", e.message); }
  }
  return plan;
}
export function savePlan() { writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2)); planMtime = statSync(PLAN_FILE).mtimeMs; }
export function setPlanetEnabled(planetId: string, v: boolean, s: State) {
  loadPlan(s);
  plan[planetId] ??= { enabled: v, keepEnergyPositive: true, priorities: [] };
  plan[planetId].enabled = v;
  savePlan();
  return plan[planetId];
}

type Choice = { key: string; name: string; next: number; cost: { metal: number; crystal: number; deuterium: number }; durationMs: number; affordable: boolean; energyOk: boolean; reason?: string };
/** Prochain bâtiment prévu pour une planète selon ses priorités (sans rien lancer). */
export function nextBuilding(p: Planet, pp: PlanetPlan): Choice | { reason: string } {
  const keepEnergy = pp.keepEnergyPositive !== false;
  for (const pr of pp.priorities) {
    const cur = p.buildings?.[pr.key] ?? 0;
    if (pr.max != null && cur >= pr.max) continue;
    const opt = (p.buildOptions ?? []).find((b: any) => b.key === pr.key);
    if (!opt) continue;                                   // clé inconnue sur cette planète
    if (opt.locked || (opt.missing ?? []).length) continue; // prérequis manquants
    const affordable = opt.cost.metal <= p.resources.metal && opt.cost.crystal <= p.resources.crystal && opt.cost.deuterium <= p.resources.deuterium;
    const energyOk = !keepEnergy || (opt.energyCost ?? 0) <= 0 || (p.energy?.balance ?? 0) - (opt.energyCost ?? 0) >= 0;
    const c: Choice = { key: pr.key, name: opt.name, next: cur + 1, cost: opt.cost, durationMs: opt.durationMs, affordable, energyOk };
    if (!energyOk) continue;                              // ferait passer l'énergie en négatif : on saute
    if (!affordable && pp.skipUnaffordable) continue;     // sinon on attend d'avoir les ressources (on ne descend pas en priorité)
    return c;
  }
  return { reason: "rien à construire (priorités atteintes, verrouillées ou énergie insuffisante)" };
}

/** Un tick : au plus un POST /build par appel. */
export async function autobuildTick(s: State) {
  const pl = loadPlan(s);
  if (!flags.autobuild) return;
  for (const p of s.planets) {
    const pp = pl[p.id];
    if (!pp?.enabled || p.buildQueue) continue;
    if (Date.now() - (lastDecision.get(p.id) ?? 0) < DECIDE_EVERY_MS) continue;
    lastDecision.set(p.id, Date.now());
    const c = nextBuilding(p, pp);
    if (!("key" in c) || !c.affordable) continue;
    try {
      const r = await api.build(p.id, c.key);
      alert(`🏗 Auto : ${p.name} → ${c.name} niveau ${c.next} lancée (${resStr(c.cost)}, ${fmtDur(c.durationMs)})`);
      log("AUTOBUILD", p.name, c.key, r);
    } catch (e: any) { alert(`❌ Auto-construction ${p.name} ${c.key} : ${e.message}`); }
    return; // un seul POST par tick
  }
}

// ---------- Résumés Telegram ----------
export function planSummary(s: State): string {
  const pl = loadPlan(s);
  return [`Auto-construction : ${flags.autobuild ? "ON" : "OFF"} (global)`, ...s.planets.map((p) => {
    const pp = pl[p.id];
    if (!pp) return `• ${p.name} : pas de plan`;
    const prio = pp.priorities.map((x) => `${x.key}${x.max != null ? `≤${x.max}` : ""}`).join(" > ") || "(vide)";
    const c = nextBuilding(p, pp);
    const next = "key" in c
      ? `→ ${c.name} niv. ${c.next} · ${resStr(c.cost)} · ${fmtDur(c.durationMs)} · ${c.affordable ? "finançable ✅" : "en attente de ressources ⏳"}`
      : `→ ${c.reason}`;
    return `• ${p.name} [${pp.enabled ? "on" : "off"}]${p.buildQueue ? ` 🏗 ${p.buildQueue.key} niv. ${p.buildQueue.targetLevel} en cours` : ""}\n  ${prio}\n  ${next}`;
  })].join("\n");
}
export function buildingsSummary(p: Planet): string {
  const rows = (p.buildOptions ?? []).map((b: any) =>
    `• ${b.key} — ${b.name} : ${b.level} → ${b.level + 1}${b.locked || (b.missing ?? []).length ? " 🔒" : ""}\n  ${resStr(b.cost)} · ${fmtDur(b.durationMs)}${b.energyCost ? ` · énergie −${fmtNum(b.energyCost)}` : ""}${(b.missing ?? []).length ? `\n  manque : ${b.missing.join(", ")}` : ""}`);
  return [`${p.name} — énergie ${p.energy?.balance ?? "?"} · champs ${p.usedFields ?? "?"}/${p.size ?? "?"}`, ...rows].join("\n");
}
