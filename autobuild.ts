// Auto-construction — règles de l'utilisateur (22/09/2026), appliquées PAR PLANÈTE (activation dans build-plan.json).
// Ordre des objectifs : robots 12 → labo 10 → chantier 8 → mines 20 (métal, cristal, deut) → silo 5. Puis plus rien.
// Trois règles transverses :
//   • Ressources insuffisantes → on passe au bâtiment suivant de la liste (jamais d'attente bloquante).
//   • Avant d'améliorer une mine, si le réservoir de CETTE ressource déborde (production perdue) → on agrandit le réservoir.
//   • Si l'amélioration retenue ferait passer l'énergie en négatif → on construit d'abord une centrale (fusion, solaire en repli).
// Le labo est bloqué pendant une recherche (erreur 400 du jeu) et le chantier pendant une production (`shipyardBusy`).
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { Planet, State } from "./spacek-client.ts";
import { alert, api, flags, fmtDur, fmtNum, log, resStr } from "./core.ts";

const PLAN_FILE = "build-plan.json";
const DECIDE_EVERY_MS = 60_000;   // au plus une décision par planète par minute
const BLOCK_MS = 30 * 60_000;     // une clé refusée par le jeu est écartée 30 min
const DEFAULT_GRACE_MS = 2 * 60_000;
const FULL_RATIO = 0.98;          // « réservoir plein » : 98 % de la capacité (la production se perd à 100 %)

export type Objectif = { key: string; max: number };
export type PlanetPlan = {
  enabled: boolean;
  objectifs?: Objectif[];
  storageWhenFull?: boolean;   // agrandir le réservoir quand la ressource déborde (défaut true)
  energyFirst?: string[];      // centrales à essayer quand l'énergie passerait en négatif (défaut fusion puis solaire)
  graceMs?: number;
};
export type BuildPlan = { defaults?: Partial<PlanetPlan> } & Record<string, PlanetPlan | Partial<PlanetPlan> | undefined>;

export const OBJECTIFS: Objectif[] = [
  { key: "robotFactory", max: 12 },
  { key: "researchLab", max: 10 },
  { key: "shipyard", max: 8 },
  { key: "metalMine", max: 20 },
  { key: "crystalMine", max: 20 },
  { key: "deuteriumSynthesizer", max: 20 },
  { key: "missileSilo", max: 5 },
];
const ENERGY_FIRST = ["fusionPlant", "solarPlant"];
const STORAGE_OF: Record<string, { res: "metal" | "crystal" | "deuterium"; storage: string }> = {
  metalMine: { res: "metal", storage: "metalStorage" },
  crystalMine: { res: "crystal", storage: "crystalStorage" },
  deuteriumSynthesizer: { res: "deuterium", storage: "deuteriumStorage" },
};

let plan: BuildPlan = {};
let planMtime = 0;
const lastDecision = new Map<string, number>();
const queueEmptySince = new Map<string, number>();
const blocked = new Map<string, { until: number; msg: string }>(); // "planetId:key" → refus du jeu

const defaultPlan = (s: State): BuildPlan => ({
  defaults: { objectifs: OBJECTIFS, storageWhenFull: true, energyFirst: ENERGY_FIRST, graceMs: DEFAULT_GRACE_MS },
  ...Object.fromEntries(s.planets.map((p) => [p.id, { enabled: false }])),
});
export function planetPlan(pl: BuildPlan, planetId: string): PlanetPlan {
  const d = pl.defaults ?? {};
  const p = (pl[planetId] ?? {}) as Partial<PlanetPlan>;
  return {
    enabled: !!p.enabled,
    objectifs: p.objectifs ?? d.objectifs ?? OBJECTIFS,
    storageWhenFull: p.storageWhenFull ?? d.storageWhenFull ?? true,
    energyFirst: p.energyFirst ?? d.energyFirst ?? ENERGY_FIRST,
    graceMs: p.graceMs ?? d.graceMs ?? DEFAULT_GRACE_MS,
  };
}
export function loadPlan(s?: State): BuildPlan {
  if (!existsSync(PLAN_FILE)) {
    if (s) { plan = defaultPlan(s); writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2)); log("build-plan.json créé"); }
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

export type Choice = { key: string; name: string; next: number; cost: { metal: number; crystal: number; deuterium: number }; durationMs: number; raison: string };
export type Skip = { key: string; why: string };
type Ctx = { researchRunning: boolean };

const level = (p: Planet, k: string) => p.buildings?.[k] ?? 0;
const opt = (p: Planet, k: string) => (p.buildOptions ?? []).find((b: any) => b.key === k);
const affordable = (p: Planet, o: any) =>
  o.cost.metal <= p.resources.metal && o.cost.crystal <= p.resources.crystal && o.cost.deuterium <= p.resources.deuterium;
const dispo = (p: Planet, k: string) => { const o = opt(p, k); return o && !o.locked && !(o.missing ?? []).length ? o : null; };

/** Bâtiment à lancer maintenant, ou la raison de ne rien faire. */
export function nextBuilding(p: Planet, pp: PlanetPlan, ctx: Ctx): { choice?: Choice; skipped: Skip[]; reason?: string } {
  const skipped: Skip[] = [];
  const bloque = (k: string) => blocked.get(`${p.id}:${k}`);
  const mk = (k: string, o: any, raison: string): Choice => ({ key: k, name: o.name, next: level(p, k) + 1, cost: o.cost, durationMs: o.durationMs, raison });

  /** Essaie une clé : renvoie le choix, ou empile la raison du refus. */
  const essaie = (k: string, raison: string): Choice | null => {
    const b = bloque(k);
    if (b && Date.now() < b.until) { skipped.push({ key: k, why: `écarté ${fmtDur(b.until - Date.now())} (${b.msg.slice(0, 60)})` }); return null; }
    if (k === "researchLab" && ctx.researchRunning) { skipped.push({ key: k, why: "recherche en cours" }); return null; }
    if (k === "researchLab" && p.labBusy) { skipped.push({ key: k, why: "labo occupé" }); return null; }
    if (k === "shipyard" && p.shipyardBusy) { skipped.push({ key: k, why: "chantier occupé" }); return null; }
    const o = dispo(p, k);
    if (!o) { skipped.push({ key: k, why: "indisponible ici" }); return null; }
    if (!affordable(p, o)) { skipped.push({ key: k, why: "ressources" }); return null; }
    return mk(k, o, raison);
  };

  /** Énergie : « ok » si le candidat passe, une centrale à construire à la place, ou « bloque » (candidat écarté). */
  const energie = (cand: Choice): { ok: true } | { plant: Choice } | { bloque: true } => {
    const cout = opt(p, cand.key)?.energyCost ?? 0;
    if (cout <= 0 || (p.energy?.balance ?? 0) - cout >= 0) return { ok: true };
    for (const k of pp.energyFirst ?? ENERGY_FIRST) {
      const c = essaie(k, `énergie : ${cand.name} coûterait ${fmtNum(cout)} (solde ${fmtNum(p.energy?.balance ?? 0)})`);
      if (c) return { plant: c };
    }
    // Aucune centrale finançable : on n'améliore PAS, sinon l'énergie passerait en négatif (production effondrée)
    skipped.push({ key: cand.key, why: `passerait l'énergie à ${fmtNum((p.energy?.balance ?? 0) - cout)}, aucune centrale finançable` });
    return { bloque: true };
  };
  /** Applique la règle énergie à un candidat : renvoie ce qu'il faut construire, ou null pour passer au suivant. */
  const valide = (c: Choice): Choice | null => {
    const e = energie(c);
    return "ok" in e ? c : "plant" in e ? e.plant : null;
  };

  for (const ob of pp.objectifs ?? OBJECTIFS) {
    if (level(p, ob.key) >= ob.max) continue;                 // objectif atteint
    // Réservoir plein : on agrandit avant d'améliorer la mine correspondante
    const st = pp.storageWhenFull !== false ? STORAGE_OF[ob.key] : undefined;
    if (st && p.capacities?.[st.res] > 0 && p.resources[st.res] >= p.capacities[st.res] * FULL_RATIO) {
      const c = essaie(st.storage, `réservoir de ${st.res} plein (${fmtNum(p.resources[st.res])}/${fmtNum(p.capacities[st.res])})`);
      const v = c && valide(c);
      if (v) return { choice: v, skipped };
    }
    const c = essaie(ob.key, `objectif ${ob.key} ≤ ${ob.max}`);
    const v = c && valide(c);
    if (v) return { choice: v, skipped };
  }
  return { skipped, reason: skipped.length ? "rien de finançable / disponible pour l'instant" : "tous les objectifs sont atteints" };
}

/** Un tick : au plus un POST /build par appel. */
export async function autobuildTick(s: State) {
  const pl = loadPlan(s);
  for (const p of s.planets) {
    if (p.buildQueue) queueEmptySince.delete(p.id);
    else queueEmptySince.set(p.id, queueEmptySince.get(p.id) ?? s.now);
  }
  if (!flags.autobuild) return; // seulement via /pause
  const ctx: Ctx = { researchRunning: !!s.player.researchQueue };
  for (const p of s.planets) {
    const pp = planetPlan(pl, p.id);
    if (!pp.enabled || p.buildQueue) continue;
    if (s.now - (queueEmptySince.get(p.id) ?? s.now) < (pp.graceMs ?? DEFAULT_GRACE_MS)) continue;
    if (Date.now() - (lastDecision.get(p.id) ?? 0) < DECIDE_EVERY_MS) continue;
    lastDecision.set(p.id, Date.now());
    const { choice } = nextBuilding(p, pp, ctx);
    if (!choice) continue;
    try {
      await api.build(p.id, choice.key);
      blocked.delete(`${p.id}:${choice.key}`);
      alert(`🏗 Auto : ${p.name} → ${choice.name} niveau ${choice.next} · ${resStr(choice.cost)} · ${fmtDur(choice.durationMs)}\n   ${choice.raison}`);
      log("AUTOBUILD", p.name, choice.key);
    } catch (e: any) {
      const msg = String(e.message).slice(0, 200);
      const k = `${p.id}:${choice.key}`;
      if (!blocked.has(k) || Date.now() > (blocked.get(k)?.until ?? 0)) alert(`⏸ ${p.name} : ${choice.name} écarté 30 min — ${msg}`);
      blocked.set(k, { until: Date.now() + BLOCK_MS, msg });
    }
    return; // un seul POST par tick
  }
}

// ---------- Résumés Telegram ----------
export function planSummary(s: State): string {
  const pl = loadPlan(s);
  const d = planetPlan(pl, "__defaults__");
  const ctx: Ctx = { researchRunning: !!s.player.researchQueue };
  const actives = s.planets.filter((p) => planetPlan(pl, p.id).enabled).map((p) => p.name);
  return [
    `Auto-construction${flags.autobuild ? "" : " ⏸ EN PAUSE (/resume)"} : ${actives.join(", ") || "aucune planète activée"}`,
    `Objectifs : ${(d.objectifs ?? OBJECTIFS).map((o) => `${o.key} ≤ ${o.max}`).join(" > ")}`,
    `Réservoir plein → agrandi · énergie négative → ${(d.energyFirst ?? ENERGY_FIRST).join(" puis ")} · pas les ressources → suivant · délai ${fmtDur(d.graceMs ?? DEFAULT_GRACE_MS)}`,
    ...s.planets.map((p) => {
      const pp = planetPlan(pl, p.id);
      const { choice, skipped, reason } = nextBuilding(p, pp, ctx);
      const cur = p.buildQueue ? ` 🏗 ${p.buildQueue.key} niv. ${p.buildQueue.targetLevel} (fin dans ${fmtDur(p.buildQueue.finishesAt - s.now)})` : "";
      const next = choice
        ? `→ ${choice.name} niv. ${choice.next} · ${resStr(choice.cost)} · ${fmtDur(choice.durationMs)}\n  (${choice.raison})`
        : `→ ${reason ?? "?"}`;
      const sk = skipped.length ? `\n  sautés : ${skipped.map((x) => `${x.key} (${x.why})`).join(", ")}` : "";
      return `• ${p.name} [${pp.enabled ? "on" : "off"}]${cur} · énergie ${fmtNum(p.energy?.balance ?? 0)}\n  ${next}${sk}`;
    }),
  ].join("\n");
}
export function buildingsSummary(p: Planet): string {
  const rows = (p.buildOptions ?? []).map((b: any) =>
    `• ${b.key} — ${b.name} : ${b.level} → ${b.level + 1}${b.locked || (b.missing ?? []).length ? " 🔒" : ""}\n  ${resStr(b.cost)} · ${fmtDur(b.durationMs)}${b.energyCost ? ` · énergie −${fmtNum(b.energyCost)}` : ""}${(b.missing ?? []).length ? `\n  manque : ${b.missing.join(", ")}` : ""}`);
  return [`${p.name} — énergie ${fmtNum(p.energy?.balance ?? 0)} · champs ${p.usedFields ?? "?"}/${p.size ?? "?"}`, ...rows].join("\n");
}
export const BUILDING_KEYS = OBJECTIFS.map((o) => o.key);
