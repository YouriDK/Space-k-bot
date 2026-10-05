// /next : une construction mise en attente par planète, lancée DÈS que la file se libère
// (pas de délai de grâce, pas de priorités : c'est un ordre manuel, typiquement pour enchaîner la nuit).
// Persisté dans next-build.json → survit aux redémarrages de pm2.
// Recherche en attente RETENUE tant qu'une planète à autobuild activé n'a pas atteint son objectif `researchLab` (sinon la recherche
// repart aussitôt et rebloque le labo pour des jours) : 12 h au plus après la libération de la file, puis on relâche avec une alerte.
// Graviton automatique (/autobuild graviton on|off, allumé par défaut) : lancé depuis Père dès qu'il apparaît dans les options de
// recherche, prioritaire sur la recherche en attente. Clé `graviton` et apparition dans `researchOptions` une fois le labo à 12 :
// [DÉDUIT] du codex du 05/10/2026 (verrouillée et absente des options tant que le labo est à 10 ; coût inconnu, prérequis d'énergie ? [HYPOTHÈSE]).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Planet, State } from "./spacek-client.ts";
import { PERE, alert, api, flags, fmtDur, log, resStr } from "./core.ts";
import { gravitonOn, loadPlan, planetPlan } from "./autobuild.ts";
import { planetReserved } from "./reserve.ts";

const FILE = "next-build.json";
const RETRY_MS = 60_000; // ressources manquantes / refus : on retente au plus une fois par minute
const HOLD_MAX_MS = 12 * 3_600_000;    // retenue de la recherche en attente : 12 h au plus
const GRAVITON_RETRY_MS = 10 * 60_000; // Graviton refusé : nouvel essai au plus toutes les 10 min
const GRAVITON = "graviton";           // [DÉDUIT] codex : research:graviton

export type NextOrder = { key: string; name: string; at: number };
export type NextResearch = NextOrder & { planetId: string };
let orders: Record<string, NextOrder> = {};
let research: NextResearch | null = null;
let gravitonAt = 0;            // Graviton lancé par le bot (ms) : on n'y revient plus
let holdSince: number | null = null; // début de la retenue de la recherche en attente (mémoire seulement : un redémarrage la relance)
const lastTry = new Map<string, number>();
const warned = new Map<string, string>(); // planetId → dernier message d'erreur signalé

try {
  if (existsSync(FILE)) {
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    // Ancien format : { "pl_2w": {...} } · nouveau : { builds: {...}, research: {...} }
    orders = raw.builds ?? Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "research")) as Record<string, NextOrder>;
    research = raw.research ?? null;
    gravitonAt = Number(raw.gravitonAt) || 0;
  }
} catch (e: any) { console.error("next-build.json illisible :", e.message); }
function persist() {
  try { writeFileSync(`${FILE}.tmp`, JSON.stringify({ builds: orders, research, gravitonAt }, null, 2)); renameSync(`${FILE}.tmp`, FILE); }
  catch (e: any) { log("next-build.json KO :", e.message); }
}

export const getNext = (planetId: string): NextOrder | undefined => orders[planetId];
export const allNext = () => ({ ...orders });
export function setNext(planetId: string, key: string, name: string) {
  orders[planetId] = { key, name, at: Date.now() };
  warned.delete(planetId); lastTry.delete(planetId);
  persist();
  return orders[planetId];
}
export function clearNext(planetId: string) { delete orders[planetId]; warned.delete(planetId); persist(); }

// ---------- Recherche en attente (une seule : le jeu ne fait qu'une recherche à la fois) ----------
export const getNextResearch = () => research;
export function setNextResearch(key: string, name: string, planetId: string) {
  research = { key, name, planetId, at: Date.now() };
  warned.delete("research"); lastTry.delete("research");
  persist();
  return research;
}
export function clearNextResearch() { research = null; warned.delete("research"); persist(); }
/** Recherches disponibles (state.researchOptions, repli sur la 1re planète). */
export const researchChoices = (s: State): BuildChoice[] =>
  (((s as any).researchOptions ?? s.planets[0]?.researchOptions ?? []) as any[]).map((r) => ({
    key: r.key, name: r.name, level: r.level, cost: r.cost, durationMs: r.durationMs,
    locked: !!r.locked || (r.missing ?? []).length > 0,
  }));
/** Planète où lancer la recherche : le meilleur laboratoire (le jeu impose un planetId). */
export const bestLab = (s: State) =>
  [...s.planets].sort((a, b) => (b.buildings?.researchLab ?? 0) - (a.buildings?.researchLab ?? 0))[0];

export type BuildChoice = { key: string; name: string; level: number; cost: { metal: number; crystal: number; deuterium: number }; durationMs: number; locked: boolean };
/** Options constructibles d'une planète, pour les boutons Telegram. */
export const buildChoices = (p: Planet): BuildChoice[] =>
  (p.buildOptions ?? []).map((b: any) => ({
    key: b.key as string, name: b.name as string, level: b.level as number, cost: b.cost,
    durationMs: b.durationMs as number, locked: !!b.locked || (b.missing ?? []).length > 0,
  }));

/** Planètes à autobuild activé dont l'objectif `researchLab` n'est pas atteint (la recherche en attente les laisse passer d'abord). */
export function labsPending(s: State): string[] {
  const pl = loadPlan(s);
  return s.planets.flatMap((p) => {
    const pp = planetPlan(pl, p.id);
    const ob = pp.enabled ? (pp.objectifs ?? []).find((o) => o.key === "researchLab") : undefined;
    const lvl = p.buildings?.researchLab ?? 0;
    return ob && lvl < ob.max ? [`${p.name} labo ${lvl} → ${ob.max}`] : [];
  });
}
/** Graviton : état lisible (pour /nexts et /plan). */
export function gravitonStatus(s: State): string {
  const on = gravitonOn(loadPlan(s));
  const lvl = s.player.research?.[GRAVITON] ?? 0;
  const rq = s.player.researchQueue;
  const o = researchChoices(s).find((c) => c.key === GRAVITON);
  const etat = lvl > 0 ? `acquis (niv. ${lvl})` : rq?.key === GRAVITON ? `en cours (fin dans ${fmtDur(rq.finishesAt - s.now)})`
    : gravitonAt ? "lancé par le bot" : !o ? "pas encore visible (labo de Père à 12 requis [DÉDUIT])" : o.locked ? "verrouillée" : `disponible · ${resStr(o.cost)} · ${fmtDur(o.durationMs)}`;
  return `🔬 Graviton auto ${on ? "on" : "off"} : ${etat}${warned.get(GRAVITON) && !lvl && rq?.key !== GRAVITON ? ` — ${warned.get(GRAVITON)}` : ""}`;
}

/** Graviton lancé dès que possible (prioritaire sur /next) : renvoie true si un POST a été tenté. */
async function gravitonTick(s: State): Promise<boolean> {
  if (!flags.autobuild || gravitonAt || s.player.researchQueue || !gravitonOn(loadPlan(s))) return false; // /pause, déjà lancé, labo occupé, off
  if ((s.player.research?.[GRAVITON] ?? 0) > 0) return false;
  const o = researchChoices(s).find((c) => c.key === GRAVITON);
  if (!o || o.locked || planetReserved(PERE)) return false;
  if (Date.now() - (lastTry.get(GRAVITON) ?? 0) < GRAVITON_RETRY_MS) return false;
  lastTry.set(GRAVITON, Date.now());
  try {
    await api.research(PERE, GRAVITON);
    gravitonAt = Date.now(); warned.delete(GRAVITON); persist();
    alert(`🔬 Graviton lancé automatiquement depuis Père · ${resStr(o.cost)} · ${fmtDur(o.durationMs)} (débloque l'étoile de la mort)`);
  } catch (e: any) {
    const msg = String(e.message).slice(0, 200);
    if (warned.get(GRAVITON) !== msg) { warned.set(GRAVITON, msg); alert(`⏳ Graviton pas encore lancé — ${msg}
Nouvel essai toutes les 10 min · /autobuild graviton off pour arrêter`); }
    log("GRAVITON KO", msg);
  }
  return true;
}

/** À chaque poll : si la file est vide et qu'un ordre attend, on le lance immédiatement. */
export async function nextBuildTick(s: State) {
  // Graviton d'abord : un essai (réussi ou non) occupe la recherche de ce passage
  const grav = await gravitonTick(s);
  // Recherche en attente : retenue tant qu'un labo d'une planète à autobuild n'a pas atteint son objectif (12 h max)
  if (!research || s.player.researchQueue) holdSince = null;
  const labs = research && !s.player.researchQueue ? labsPending(s) : [];
  if (!labs.length) holdSince = null;
  let held = false;
  if (labs.length && research) {
    if (holdSince == null) {
      holdSince = Date.now();
      alert(`🔬 Recherche ${research.name} retenue : les labos passent d'abord (${labs.join(", ")}) — relâchée au plus tard dans ${fmtDur(HOLD_MAX_MS)}`);
    }
    held = Date.now() - holdSince < HOLD_MAX_MS;
    if (!held && warned.get("hold") !== String(holdSince)) {
      warned.set("hold", String(holdSince));
      alert(`🔬 Retenue de ${research.name} levée après ${fmtDur(HOLD_MAX_MS)} : lancement malgré ${labs.join(", ")}`);
    }
  }
  // Recherche : une seule à la fois pour tout l'empire
  if (research && !grav && !held && !s.player.researchQueue && !planetReserved(research.planetId) && Date.now() - (lastTry.get("research") ?? 0) >= RETRY_MS) {
    lastTry.set("research", Date.now());
    const r = research;
    try {
      await api.research(r.planetId, r.key);
      const lvl = (s.player.research?.[r.key] ?? 0) + 1;
      const where = s.planets.find((x) => x.id === r.planetId)?.name ?? r.planetId;
      clearNextResearch();
      alert(`🔬 ${r.name} niveau ${lvl} lancée depuis ${where} (en attente depuis ${fmtDur(Date.now() - r.at)})`);
    } catch (e: any) {
      const msg = String(e.message).slice(0, 200);
      if (warned.get("research") !== msg) { warned.set("research", msg); alert(`⏳ Recherche ${r.name} en attente — ${msg}`); }
      log("NEXT RECHERCHE KO", r.key, msg);
    }
  }
  for (const p of s.planets) {
    const o = orders[p.id];
    if (!o || p.buildQueue || planetReserved(p.id)) continue; // /fleetbuild ou financement : ressources réservées
    if (Date.now() - (lastTry.get(p.id) ?? 0) < RETRY_MS) continue;
    lastTry.set(p.id, Date.now());
    try {
      await api.build(p.id, o.key);
      const lvl = (p.buildings?.[o.key] ?? 0) + 1;
      clearNext(p.id);
      alert(`⏭ ${p.name} : ${o.name} niveau ${lvl} lancé (mis en attente il y a ${fmtDur(Date.now() - o.at)})`);
    } catch (e: any) {
      const msg = String(e.message).slice(0, 200);
      if (warned.get(p.id) !== msg) { warned.set(p.id, msg); alert(`⏳ ${p.name} : ${o.name} en attente — ${msg}`); }
      log("NEXT KO", p.name, o.key, msg);
    }
  }
}

export function nextSummary(s: State): string {
  const rq = s.player.researchQueue;
  const labs = labsPending(s);
  const hold = research && labs.length ? ` (retenue : ${labs.join(", ")}${holdSince ? `, relâchée dans ${fmtDur(Math.max(0, holdSince + HOLD_MAX_MS - Date.now()))}` : ""})` : "";
  const resLine = `• Recherche — ${rq ? `🔬 ${rq.key} niv. ${rq.targetLevel} (fin dans ${fmtDur(rq.finishesAt - s.now)})` : "aucune en cours"}\n  ${research ? `⏭ en attente : ${research.name}${hold}` : "⏭ rien en attente"}\n  ${gravitonStatus(s)}`;
  const lines = s.planets.map((p) => {
    const o = orders[p.id];
    const cur = p.buildQueue ? `🏗 ${p.buildQueue.key} niv. ${p.buildQueue.targetLevel} (fin dans ${fmtDur(p.buildQueue.finishesAt - s.now)})` : "file libre";
    const opt = o ? (p.buildOptions ?? []).find((b: any) => b.key === o.key) : null;
    return `• ${p.name} — ${cur}\n  ${o ? `⏭ en attente : ${o.name}${opt ? ` niv. ${opt.level + 1} · ${resStr(opt.cost)}` : ""}` : "⏭ rien en attente"}`;
  });
  return ["⏭ Prochaines constructions (lancées dès que la file se libère)", resLine, ...lines].join("\n");
}
