// Auto-construction par PALIERS (règles utilisateur du 21/09) : quand la file d'une planète est vide depuis ≥ 2 min,
// parcourir la liste ordonnée et monter chaque bâtiment au palier courant (5, puis 7, 9, 10, puis niveau par niveau) ;
// pas les ressources ou énergie négative → on passe au suivant de la liste. Flag global `autobuild` + `enabled` par planète.
// build-plan.json est rechargé dès qu'il change sur le disque (édition à la main sans redémarrer) :
//   { "defaults": { "order": [...], "tiers": [5,7,9,10], "continueAfterTiers": true, "graceMs": 120000 },
//     "pl_2w": { "enabled": false }, "pl_rn": { "enabled": true, "tiers": [5,7] }, ... }
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { Planet, State } from "./spacek-client.ts";
import { alert, api, flags, fmtDur, fmtNum, log, resStr } from "./core.ts";

const PLAN_FILE = "build-plan.json";
const DECIDE_EVERY_MS = 60_000; // au plus une décision par planète par minute

export type PlanetPlan = {
  enabled: boolean;
  order?: string[];            // ordre de parcours (défaut : defaults.order)
  tiers?: number[];            // paliers : on monte toute la liste au palier N avant de passer au suivant (défaut : defaults.tiers)
  continueAfterTiers?: boolean; // après le dernier palier : niveau par niveau (11, 12, …) dans le même ordre (défaut true)
  graceMs?: number;            // délai après la fin d'un bâtiment avant de lancer en auto (défaut 2 min) — laisse la main à l'utilisateur
};
export type BuildPlan = { defaults?: Partial<PlanetPlan> } & Record<string, PlanetPlan | Partial<PlanetPlan> | undefined>;

// Les 12 bâtiments vus dans buildOptions le 21/09 (nom affiché = buildOptions[].name), dans l'ORDRE DE PRIORITÉ de l'utilisateur
export const BUILDING_KEYS = [
  "robotFactory", "shipyard", "researchLab", "solarPlant", "fusionPlant", "crystalMine",
  "deuteriumSynthesizer", "metalMine", "missileSilo", "metalStorage", "crystalStorage", "deuteriumStorage",
];
const DEFAULT_TIERS = [5, 7, 9, 10];
const DEFAULT_GRACE_MS = 2 * 60_000;
const MAX_LEVEL = 60; // borne du « niveau par niveau » après les paliers

let plan: BuildPlan = {};
let planMtime = 0;
const lastDecision = new Map<string, number>();
const queueEmptySince = new Map<string, number>(); // planetId → horloge serveur à laquelle la file est devenue vide

function defaultPlan(s: State): BuildPlan {
  return {
    defaults: { order: BUILDING_KEYS, tiers: DEFAULT_TIERS, continueAfterTiers: true, graceMs: DEFAULT_GRACE_MS },
    ...Object.fromEntries(s.planets.map((p) => [p.id, { enabled: false }])),
  };
}
/** Plan effectif d'une planète = defaults + surcharges de la planète. */
export function planetPlan(pl: BuildPlan, planetId: string): PlanetPlan {
  const d = pl.defaults ?? {};
  const p = (pl[planetId] ?? {}) as Partial<PlanetPlan>;
  return {
    enabled: !!p.enabled, order: p.order ?? d.order ?? BUILDING_KEYS, tiers: p.tiers ?? d.tiers ?? DEFAULT_TIERS,
    continueAfterTiers: p.continueAfterTiers ?? d.continueAfterTiers ?? true, graceMs: p.graceMs ?? d.graceMs ?? DEFAULT_GRACE_MS,
  };
}
/** Recharge build-plan.json s'il a changé ; le crée avec les défauts (tout désactivé) s'il n'existe pas. */
export function loadPlan(s?: State): BuildPlan {
  if (!existsSync(PLAN_FILE)) {
    if (s) { plan = defaultPlan(s); writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2)); log("build-plan.json créé (défauts, tout désactivé)"); }
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
  plan[planetId] = { ...(plan[planetId] ?? {}), enabled: v };
  savePlan();
  return planetPlan(plan, planetId);
}

type Choice = { key: string; name: string; next: number; tier: number; cost: { metal: number; crystal: number; deuterium: number }; durationMs: number; energyCost: number };
type Skip = { key: string; next: number; why: "ressources" | "énergie" };
/** Prochain bâtiment selon les paliers : 1er de la liste sous le palier courant, finançable et sans passer l'énergie en négatif ;
 *  sinon le suivant de la liste (décision utilisateur). Ne rien lancer si rien n'est éligible. */
export function nextBuilding(p: Planet, pp: PlanetPlan): { choice?: Choice; skipped: Skip[]; tier?: number; reason?: string } {
  const opts = new Map<string, any>((p.buildOptions ?? []).map((b: any) => [b.key, b]));
  const level = (k: string) => p.buildings?.[k] ?? 0;
  const tiers = [...(pp.tiers ?? DEFAULT_TIERS)];
  if (pp.continueAfterTiers !== false) for (let t = (tiers[tiers.length - 1] ?? 0) + 1; t <= MAX_LEVEL; t++) tiers.push(t);
  const skipped: Skip[] = [];
  const buildable = (k: string) => { const o = opts.get(k); return o && !o.locked && !(o.missing ?? []).length; };
  for (const tier of tiers) {
    const todo = (pp.order ?? BUILDING_KEYS).filter((k) => buildable(k) && level(k) < tier);
    if (!todo.length) continue; // palier atteint partout (ou bâtiments indisponibles) → palier suivant
    for (const k of todo) {
      const o = opts.get(k);
      const affordable = o.cost.metal <= p.resources.metal && o.cost.crystal <= p.resources.crystal && o.cost.deuterium <= p.resources.deuterium;
      const energyOk = (o.energyCost ?? 0) <= 0 || (p.energy?.balance ?? 0) - (o.energyCost ?? 0) >= 0;
      if (!affordable) { skipped.push({ key: k, next: level(k) + 1, why: "ressources" }); continue; }
      if (!energyOk) { skipped.push({ key: k, next: level(k) + 1, why: "énergie" }); continue; }
      return { choice: { key: k, name: o.name, next: level(k) + 1, tier, cost: o.cost, durationMs: o.durationMs, energyCost: o.energyCost ?? 0 }, skipped, tier };
    }
    return { skipped, tier, reason: `palier ${tier} : rien de finançable / compatible énergie pour l'instant` };
  }
  return { skipped, reason: "tous les paliers atteints" };
}

/** Un tick : au plus un POST /build par appel. Respecte le délai de grâce après la fin d'un bâtiment. */
export async function autobuildTick(s: State) {
  const pl = loadPlan(s);
  for (const p of s.planets) {
    if (p.buildQueue) queueEmptySince.delete(p.id);
    else queueEmptySince.set(p.id, queueEmptySince.get(p.id) ?? s.now); // 1re fois vue vide (au démarrage : délai complet)
  }
  if (!flags.autobuild) return;
  for (const p of s.planets) {
    const pp = planetPlan(pl, p.id);
    if (!pp.enabled || p.buildQueue) continue;
    if (s.now - (queueEmptySince.get(p.id) ?? s.now) < (pp.graceMs ?? DEFAULT_GRACE_MS)) continue; // laisse 2 min à l'utilisateur
    if (Date.now() - (lastDecision.get(p.id) ?? 0) < DECIDE_EVERY_MS) continue;
    lastDecision.set(p.id, Date.now());
    const { choice, skipped } = nextBuilding(p, pp);
    if (!choice) continue;
    try {
      const r = await api.build(p.id, choice.key);
      const sk = skipped.length ? ` (sautés : ${skipped.map((x) => `${x.key} ${x.why}`).join(", ")})` : "";
      alert(`🏗 Auto : ${p.name} → ${choice.name} niveau ${choice.next} lancée [palier ${choice.tier}] · ${resStr(choice.cost)} · ${fmtDur(choice.durationMs)}${sk}`);
      log("AUTOBUILD", p.name, choice.key, r);
    } catch (e: any) { alert(`❌ Auto-construction ${p.name} ${choice.key} : ${e.message}`); }
    return; // un seul POST par tick
  }
}

// ---------- Résumés Telegram ----------
export function planSummary(s: State): string {
  const pl = loadPlan(s);
  const d = planetPlan(pl, "__defaults__");
  return [
    `Auto-construction : ${flags.autobuild ? "ON" : "OFF"} (global) · paliers ${(d.tiers ?? []).join(" → ")}${d.continueAfterTiers !== false ? " puis +1" : ""} · délai ${fmtDur(d.graceMs ?? DEFAULT_GRACE_MS)} après chaque fin`,
    `Ordre : ${(d.order ?? []).join(" > ")}`,
    ...s.planets.map((p) => {
      const pp = planetPlan(pl, p.id);
      const { choice, skipped, tier, reason } = nextBuilding(p, pp);
      const cur = p.buildQueue ? ` 🏗 ${p.buildQueue.key} niv. ${p.buildQueue.targetLevel} en cours (fin dans ${fmtDur(p.buildQueue.finishesAt - s.now)})` : "";
      const next = choice
        ? `→ ${choice.name} niv. ${choice.next} [palier ${choice.tier}] · ${resStr(choice.cost)} · ${fmtDur(choice.durationMs)}`
        : `→ ${reason ?? "?"}`;
      const sk = skipped.length ? `\n  sautés : ${skipped.map((x) => `${x.key}→${x.next} (${x.why})`).join(", ")}` : "";
      return `• ${p.name} [${pp.enabled ? "on" : "off"}]${cur}${tier ? ` · palier ${tier}` : ""}\n  ${next}${sk}`;
    }),
  ].join("\n");
}
export function buildingsSummary(p: Planet): string {
  const rows = (p.buildOptions ?? []).map((b: any) =>
    `• ${b.key} — ${b.name} : ${b.level} → ${b.level + 1}${b.locked || (b.missing ?? []).length ? " 🔒" : ""}\n  ${resStr(b.cost)} · ${fmtDur(b.durationMs)}${b.energyCost ? ` · énergie −${fmtNum(b.energyCost)}` : ""}${(b.missing ?? []).length ? `\n  manque : ${b.missing.join(", ")}` : ""}`);
  return [`${p.name} — énergie ${p.energy?.balance ?? "?"} · champs ${p.usedFields ?? "?"}/${p.size ?? "?"}`, ...rows].join("\n");
}
