// Auto-construction — règles de l'utilisateur (22/09/2026, revues le 05/10/2026), appliquées PAR PLANÈTE (activation dans build-plan.json).
// Ordre des objectifs : labo 10 → nanites 4 → robots 12 → chantier 8 → mines 20 (métal, cristal, deut) → silo 5. Puis plus rien.
// Plafonds par planète (`plafonds`, fusionnés sur les objectifs sans recopier la liste) : Père labo 12 (débloque Graviton).
// Règles transverses, dans l'ordre de décision :
//   • Énergie DÉJÀ négative → une centrale avant tout le reste (energyFirst de la planète).
//   • Ressources insuffisantes → on passe au bâtiment suivant de la liste (jamais d'attente bloquante). Le premier candidat écarté
//     pour cette seule raison est le « besoin » de la planète : c'est lui que Père finance (buildfund.ts, /autobuild finance).
//   • Avant d'améliorer une mine, si le réservoir de CETTE ressource déborde (production perdue) → on agrandit le réservoir.
//   • Si une amélioration ferait passer l'énergie en négatif → on construit d'abord une centrale (fusion, solaire en repli).
//   • En dernier : réservoir ≥ 98 % alors que sa mine est au plafond → on l'agrandit, payé par le stock local uniquement (jamais un besoin).
// Le labo est bloqué pendant une recherche (erreur 400 du jeu) et le chantier pendant une production (`shipyardBusy`).
// build-plan.json n'est jamais copié par /maj : les nouveaux défauts passent par une migration au chargement (version dans `defaults`).
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { Planet, State } from "./spacek-client.ts";
import { PERE, alert, api, flags, fmtDur, fmtNum, log, resStr } from "./core.ts";
import { planetReserved, reservedWhy } from "./reserve.ts";

const PLAN_FILE = "build-plan.json";
const PLAN_VERSION = 2;           // 2 = objectifs du 05/10/2026 (labo, nanites 4 en tête), plafond labo 12 sur Père, financement + Graviton
const DECIDE_EVERY_MS = 60_000;   // au plus une décision par planète par minute
const BLOCK_MS = 30 * 60_000;     // une clé refusée par le jeu est écartée 30 min
const DEFAULT_GRACE_MS = 2 * 60_000;
const FULL_RATIO = 0.98;          // « réservoir plein » : 98 % de la capacité (la production se perd à 100 %)

export type Objectif = { key: string; max: number };
export type PlanetPlan = {
  enabled: boolean;
  objectifs?: Objectif[];
  plafonds?: Record<string, number>; // surcharge du max par clé, fusionnée sur les objectifs (clé absente de la liste → ajoutée à la fin)
  storageWhenFull?: boolean;   // agrandir le réservoir quand la ressource déborde (défaut true)
  energyFirst?: string[];      // centrales à essayer quand l'énergie passerait en négatif (défaut fusion puis solaire)
  graceMs?: number;
};
/** Réglages globaux, rangés dans `defaults` : version du fichier, financement des colonies par Père, Graviton automatique. */
export type PlanDefaults = Partial<PlanetPlan> & { version?: number; financement?: boolean; graviton?: boolean };
export type BuildPlan = { defaults?: PlanDefaults } & Record<string, PlanDefaults | undefined>;

export const OBJECTIFS: Objectif[] = [
  { key: "researchLab", max: 10 },
  { key: "naniteFactory", max: 4 },
  { key: "robotFactory", max: 12 },
  { key: "shipyard", max: 8 },
  { key: "metalMine", max: 20 },
  { key: "crystalMine", max: 20 },
  { key: "deuteriumSynthesizer", max: 20 },
  { key: "missileSilo", max: 5 },
];
const PLAFONDS_PERE: Record<string, number> = { researchLab: 12 }; // labo 12 : prérequis de Graviton (codex du 05/10/2026)
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
  defaults: { version: PLAN_VERSION, objectifs: OBJECTIFS, storageWhenFull: true, energyFirst: ENERGY_FIRST, graceMs: DEFAULT_GRACE_MS, financement: true, graviton: true },
  ...Object.fromEntries(s.planets.map((p) => [p.id, p.id === PERE ? { enabled: false, plafonds: { ...PLAFONDS_PERE } } : { enabled: false }])),
});
/** Migration d'un plan d'ancienne version (celui du téléphone porte les anciens objectifs écrits en dur) : nouveaux objectifs par défaut,
 *  plafond labo 12 sur Père, financement et Graviton allumés s'ils sont absents ; tout le reste (activations, energyFirst, graceMs…) conservé.
 *  Idempotent : renvoie false si le plan est déjà à jour. */
export function migratePlan(pl: BuildPlan): boolean {
  const d = pl.defaults ?? {};
  if ((d.version ?? 1) >= PLAN_VERSION) return false;
  pl.defaults = { ...d, objectifs: OBJECTIFS, financement: d.financement ?? true, graviton: d.graviton ?? true, version: PLAN_VERSION };
  const pere = pl[PERE] ?? { enabled: false };
  pl[PERE] = { ...pere, plafonds: { ...(pere.plafonds ?? {}), ...PLAFONDS_PERE } };
  return true;
}
/** Plafonds fusionnés sur une liste d'objectifs (ordre conservé ; clé inconnue de la liste → ajoutée à la fin). */
const fusion = (obs: Objectif[], pl: Record<string, number>): Objectif[] => [
  ...obs.map((o) => (o.key in pl ? { ...o, max: pl[o.key] } : o)),
  ...Object.entries(pl).filter(([k]) => !obs.some((o) => o.key === k)).map(([key, max]) => ({ key, max })),
];
export function planetPlan(pl: BuildPlan, planetId: string): PlanetPlan {
  const d = pl.defaults ?? {};
  const p = (pl[planetId] ?? {}) as Partial<PlanetPlan>;
  const plafonds = { ...d.plafonds, ...p.plafonds };
  return {
    enabled: !!p.enabled,
    objectifs: fusion(p.objectifs ?? d.objectifs ?? OBJECTIFS, plafonds),
    plafonds,
    storageWhenFull: p.storageWhenFull ?? d.storageWhenFull ?? true,
    energyFirst: p.energyFirst ?? d.energyFirst ?? ENERGY_FIRST,
    graceMs: p.graceMs ?? d.graceMs ?? DEFAULT_GRACE_MS,
  };
}
export function loadPlan(s?: State): BuildPlan {
  if (!existsSync(PLAN_FILE)) {
    if (s) { plan = defaultPlan(s); savePlan(); log("build-plan.json créé"); }
    return plan;
  }
  const m = statSync(PLAN_FILE).mtimeMs;
  if (m !== planMtime) {
    try {
      plan = JSON.parse(readFileSync(PLAN_FILE, "utf8")); planMtime = m; log("build-plan.json rechargé");
      if (migratePlan(plan)) {
        savePlan();
        alert(`🏗 build-plan.json migré (version ${PLAN_VERSION}) : objectifs ${OBJECTIFS.map((o) => `${o.key} ${o.max}`).join(" > ")} · Père labo 12 · financement par Père ${plan.defaults?.financement ? "on" : "off"} · Graviton auto ${plan.defaults?.graviton ? "on" : "off"} (activations conservées)`);
      }
    } catch (e: any) { log("build-plan.json invalide :", e.message); }
  }
  return plan;
}
export function savePlan() {
  writeFileSync(`${PLAN_FILE}.tmp`, JSON.stringify(plan, null, 2)); renameSync(`${PLAN_FILE}.tmp`, PLAN_FILE);
  planMtime = statSync(PLAN_FILE).mtimeMs;
}
export function setPlanetEnabled(planetId: string, v: boolean, s: State) {
  loadPlan(s);
  plan[planetId] = { ...(plan[planetId] ?? {}), enabled: v };
  savePlan();
  return planetPlan(plan, planetId);
}
/** Réglages globaux (`/autobuild finance on|off`, `/autobuild graviton on|off`). */
export const financementOn = (pl: BuildPlan = plan) => pl.defaults?.financement !== false;
export const gravitonOn = (pl: BuildPlan = plan) => pl.defaults?.graviton !== false;
export function setPlanDefault(k: "financement" | "graviton", v: boolean, s: State) {
  loadPlan(s);
  plan.defaults = { ...(plan.defaults ?? {}), [k]: v };
  savePlan();
  log("PLAN", k, "=", v);
}

export type Choice = { key: string; name: string; next: number; cost: { metal: number; crystal: number; deuterium: number }; durationMs: number; raison: string };
export type Skip = { key: string; why: string };
export type Ctx = { researchRunning: boolean };
/** choice = à lancer maintenant · besoin = premier candidat (ordre de décision) écarté UNIQUEMENT faute de ressources : ce que Père peut financer. */
export type Decision = { choice?: Choice; besoin?: Choice; skipped: Skip[]; reason?: string };
export const buildCtx = (s: State): Ctx => ({ researchRunning: !!s.player.researchQueue });

const level = (p: Planet, k: string) => p.buildings?.[k] ?? 0;
const opt = (p: Planet, k: string) => (p.buildOptions ?? []).find((b: any) => b.key === k);
const affordable = (p: Planet, o: any) =>
  o.cost.metal <= p.resources.metal && o.cost.crystal <= p.resources.crystal && o.cost.deuterium <= p.resources.deuterium;
const dispo = (p: Planet, k: string) => { const o = opt(p, k); return o && !o.locked && !(o.missing ?? []).length ? o : null; };
const mk = (p: Planet, k: string, o: any, raison: string): Choice => ({ key: k, name: o.name, next: level(p, k) + 1, cost: o.cost, durationMs: o.durationMs, raison });

/** Bâtiment à lancer maintenant, le besoin à financer, ou la raison de ne rien faire. */
export function nextBuilding(p: Planet, pp: PlanetPlan, ctx: Ctx): Decision {
  const skipped: Skip[] = [];
  let besoin: Choice | undefined;
  const bal = p.energy?.balance ?? 0;
  const plants = pp.energyFirst ?? ENERGY_FIRST;
  const bloque = (k: string) => blocked.get(`${p.id}:${k}`);

  /** Évaluation d'une clé (une seule par clé : pas de doublon dans « sautés ») : c = finançable sur place · manque = seules les ressources manquent. */
  type Essai = { c?: Choice; manque?: Choice };
  const tried = new Map<string, Essai>();
  const essaie = (k: string, raison: string): Essai => {
    const t = tried.get(k);
    if (t) return t;
    const r = ((): Essai => {
      const b = bloque(k);
      if (b && Date.now() < b.until) { skipped.push({ key: k, why: `écarté ${fmtDur(b.until - Date.now())} (${b.msg.slice(0, 60)})` }); return {}; }
      if (k === "researchLab" && ctx.researchRunning) { skipped.push({ key: k, why: "recherche en cours" }); return {}; }
      if (k === "researchLab" && p.labBusy) { skipped.push({ key: k, why: "labo occupé" }); return {}; }
      if (k === "shipyard" && p.shipyardBusy) { skipped.push({ key: k, why: "chantier occupé" }); return {}; }
      const o = dispo(p, k);
      if (!o) { skipped.push({ key: k, why: "indisponible ici" }); return {}; }
      if (!affordable(p, o)) { skipped.push({ key: k, why: "ressources" }); return { manque: mk(p, k, o, raison) }; }
      return { c: mk(p, k, o, raison) };
    })();
    tried.set(k, r);
    return r;
  };
  const retenir = (m: Choice | undefined, finance: boolean) => { if (m && finance && !besoin) besoin = m; };

  /** Règle énergie appliquée à un candidat (finançable ou non) : ce qu'il faut construire maintenant, ou null (besoin retenu au passage). */
  const valide = (e: Essai, finance: boolean): Choice | null => {
    const cand = e.c ?? e.manque;
    if (!cand) return null;
    const cout = opt(p, cand.key)?.energyCost ?? 0;
    if (cout > 0 && bal - cout < 0) {
      // La centrale est le substitut du candidat : construite si finançable, sinon c'est elle le besoin
      for (const k of plants) {
        const pe = essaie(k, `énergie : ${cand.name} coûterait ${fmtNum(cout)} (solde ${fmtNum(bal)})`);
        if (pe.c) return pe.c;
        retenir(pe.manque, finance);
      }
      // Aucune centrale finançable : on n'améliore PAS, sinon l'énergie passerait en négatif (production effondrée)
      skipped.push({ key: cand.key, why: `passerait l'énergie à ${fmtNum(bal - cout)}, aucune centrale finançable` });
      return null;
    }
    if (e.c) return e.c;
    retenir(e.manque, finance);
    return null;
  };
  const fin = (choice?: Choice): Decision =>
    choice ? { choice, besoin, skipped } : { besoin, skipped, reason: skipped.length ? "rien de finançable / disponible pour l'instant" : "tous les objectifs sont atteints" };

  // 1. Énergie déjà négative : une centrale avant tout le reste
  if (bal < 0) {
    for (const k of plants) {
      const e = essaie(k, `énergie négative (${fmtNum(bal)})`);
      if (e.c) return fin(e.c);
      retenir(e.manque, true);
    }
  }
  // 2. Objectifs dans l'ordre, avec leurs substituts réservoir / centrale
  const objectifs = pp.objectifs ?? OBJECTIFS;
  for (const ob of objectifs) {
    if (level(p, ob.key) >= ob.max) continue;                 // objectif atteint
    // Réservoir plein : on agrandit avant d'améliorer la mine correspondante
    const st = pp.storageWhenFull !== false ? STORAGE_OF[ob.key] : undefined;
    if (st && p.capacities?.[st.res] > 0 && p.resources[st.res] >= p.capacities[st.res] * FULL_RATIO) {
      const v = valide(essaie(st.storage, `réservoir de ${st.res} plein (${fmtNum(p.resources[st.res])}/${fmtNum(p.capacities[st.res])})`), true);
      if (v) return fin(v);
    }
    const v = valide(essaie(ob.key, `objectif ${ob.key} ≤ ${ob.max}`), true);
    if (v) return fin(v);
  }
  // 3. En dernier : réservoir plein alors que la mine est au plafond (production perdue), payé sur place uniquement
  if (pp.storageWhenFull !== false) {
    for (const [mine, st] of Object.entries(STORAGE_OF)) {
      const ob = objectifs.find((o) => o.key === mine);
      if (ob && level(p, mine) < ob.max) continue; // mine sous son objectif : règle d'avant la mine (étape 2)
      if (!(p.capacities?.[st.res] > 0 && p.resources[st.res] >= p.capacities[st.res] * FULL_RATIO)) continue;
      const v = valide(essaie(st.storage, `réservoir de ${st.res} plein, mine au plafond (${fmtNum(p.resources[st.res])}/${fmtNum(p.capacities[st.res])})`), false);
      if (v) return fin(v);
    }
  }
  return fin();
}
/** Prochain objectif non atteint (disponible ici, même bloqué par une recherche ou faute de ressources) : sert au plancher de Père. */
export function nextObjective(p: Planet, pp: PlanetPlan): Choice | undefined {
  for (const ob of pp.objectifs ?? OBJECTIFS) {
    if (level(p, ob.key) >= ob.max) continue;
    const o = dispo(p, ob.key);
    if (o) return mk(p, ob.key, o, `objectif ${ob.key} ≤ ${ob.max}`);
  }
  return undefined;
}
/** Un tick : au plus un POST /build par appel. */
export async function autobuildTick(s: State) {
  const pl = loadPlan(s);
  for (const p of s.planets) {
    if (p.buildQueue) queueEmptySince.delete(p.id);
    else queueEmptySince.set(p.id, queueEmptySince.get(p.id) ?? s.now);
  }
  if (!flags.autobuild) return; // seulement via /pause
  const ctx = buildCtx(s);
  for (const p of s.planets) {
    const pp = planetPlan(pl, p.id);
    if (!pp.enabled || p.buildQueue || planetReserved(p.id)) continue; // /fleetbuild ou financement : ressources réservées
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
  const ctx = buildCtx(s);
  const actives = s.planets.filter((p) => planetPlan(pl, p.id).enabled).map((p) => p.name);
  const defMax = new Map((d.objectifs ?? OBJECTIFS).map((o) => [o.key, o.max]));
  return [
    `Auto-construction${flags.autobuild ? "" : " ⏸ EN PAUSE (/resume)"} : ${actives.join(", ") || "aucune planète activée"}`,
    `Objectifs : ${(d.objectifs ?? OBJECTIFS).map((o) => `${o.key} ≤ ${o.max}`).join(" > ")}`,
    `Énergie négative → centrale d'abord · réservoir plein → agrandi (avant la mine ; en dernier si la mine est au plafond, payé sur place) · énergie qui passerait en négatif → ${(d.energyFirst ?? ENERGY_FIRST).join(" puis ")} · pas les ressources → suivant · délai ${fmtDur(d.graceMs ?? DEFAULT_GRACE_MS)}`,
    `Financement des colonies par Père : ${financementOn(pl) ? "on" : "off"} (/autobuild finance on|off) · Graviton auto : ${gravitonOn(pl) ? "on" : "off"} (/autobuild graviton on|off)`,
    ...s.planets.map((p) => {
      const pp = planetPlan(pl, p.id);
      const { choice, besoin, skipped, reason } = nextBuilding(p, pp, ctx);
      const cur = p.buildQueue ? ` 🏗 ${p.buildQueue.key} niv. ${p.buildQueue.targetLevel} (fin dans ${fmtDur(p.buildQueue.finishesAt - s.now)})` : "";
      const plaf = (pp.objectifs ?? []).filter((o) => defMax.get(o.key) !== o.max);
      const res = reservedWhy(p.id);
      const next = choice
        ? `→ ${choice.name} niv. ${choice.next} · ${resStr(choice.cost)} · ${fmtDur(choice.durationMs)}\n  (${choice.raison})`
        : `→ ${reason ?? "?"}`;
      const bes = besoin
        ? `\n  besoin : ${besoin.name} niv. ${besoin.next} · ${resStr(besoin.cost)} — ${p.id === PERE ? "payé sur place" : financementOn(pl) && pp.enabled ? "finançable par Père" : "financement off"}`
        : "";
      const sk = skipped.length ? `\n  sautés : ${skipped.map((x) => `${x.key} (${x.why})`).join(", ")}` : "";
      return `• ${p.name} [${pp.enabled ? "on" : "off"}]${cur} · énergie ${fmtNum(p.energy?.balance ?? 0)}${plaf.length ? ` · plafonds ${plaf.map((o) => `${o.key} ${o.max}`).join(", ")}` : ""}` +
        `${res ? `\n  ⛔ ${res}` : ""}\n  ${next}${bes}${sk}`;
    }),
  ].join("\n");
}
export function buildingsSummary(p: Planet): string {
  const rows = (p.buildOptions ?? []).map((b: any) =>
    `• ${b.key} — ${b.name} : ${b.level} → ${b.level + 1}${b.locked || (b.missing ?? []).length ? " 🔒" : ""}\n  ${resStr(b.cost)} · ${fmtDur(b.durationMs)}${b.energyCost ? ` · énergie −${fmtNum(b.energyCost)}` : ""}${(b.missing ?? []).length ? `\n  manque : ${b.missing.join(", ")}` : ""}`);
  return [`${p.name} — énergie ${fmtNum(p.energy?.balance ?? 0)} · champs ${p.usedFields ?? "?"}/${p.size ?? "?"}`, ...rows].join("\n");
}
export const BUILDING_KEYS = OBJECTIFS.map((o) => o.key);
