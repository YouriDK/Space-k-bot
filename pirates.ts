// Veille des caches pirates (T0/T1/T2 ↔ presets /p0 /p1 /p2) et convois : toutes les PIRATE_CHECK_MS, un seul GET /galaxy/carte ;
// quand le nombre de pirates d'un système change (ou au démarrage), on lit ce système et on notifie les nouvelles caches.
// Formes [TESTÉ 21/09] : carte.systemes[].pirates (nombre) ; /galaxy?system=N → slots[].pirate = { nom, tier, expireA, maitrise, boss? }
// et slots[].convoi = { tier, epave, total, … } [BUNDLE].
import type { GalaxySlot, State } from "./spacek-client.ts";
import { alert, api, fmtDur, log, num, sleep } from "./core.ts";
import { postDiscord } from "./discord.ts";

const PIRATE_CHECK_MS = num("PIRATE_CHECK_MS", 5 * 60_000);
export type Pirate = { system: number; position: number; nom: string; tier: string; expireA?: number; maitrise?: boolean; boss?: boolean; kind: "pirate" | "convoi"; raw: any };

let lastCheck = 0;
let lastCounts = new Map<number, number>();
const known = new Map<string, Pirate>(); // "sys:pos:expireA" → cache vue
let started = false;

const key = (p: Pirate) => `${p.system}:${p.position}:${p.expireA ?? ""}`;
export const presetFor = (tier?: string) => tier === "T0" ? "/p0" : tier === "T1" ? "/p1" : tier === "T2" ? "/p2" : null;
const fromSlot = (system: number, sl: GalaxySlot): Pirate | null =>
  sl.pirate ? { system, position: sl.position, nom: sl.pirate.nom ?? "Cache pirate", tier: sl.pirate.tier ?? "?", expireA: sl.pirate.expireA, maitrise: sl.pirate.maitrise, boss: sl.pirate.boss, kind: "pirate", raw: sl.pirate }
  : sl.convoi ? { system, position: sl.position, nom: sl.convoi.epave ? "Épave" : "Convoi pirate", tier: sl.convoi.tier ?? "?", kind: "convoi", raw: sl.convoi } : null;

export function pirateLine(p: Pirate, now: number) {
  const preset = presetFor(p.tier);
  return `☠ ${p.nom} ${p.tier}${p.boss ? " (boss)" : ""} en ${p.system}:${p.position}` +
    (p.expireA ? ` · expire dans ${fmtDur(p.expireA - now)}` : "") + (p.maitrise ? " · échelon déjà maîtrisé" : "") +
    (preset && !p.maitrise ? `\n   → ${preset} under|over|trio ${p.system}:${p.position}` : "");
}

/** Relève les caches d'un système (appel direct : on veut du frais quand le compte a changé). */
async function readSystem(n: number): Promise<Pirate[]> {
  const sys = await api.galaxySystem(n);
  await sleep(150);
  return sys.slots.map((sl) => fromSlot(n, sl)).filter(Boolean) as Pirate[];
}

/** À appeler à chaque poll ; ne fait un appel réseau que toutes les PIRATE_CHECK_MS. */
export async function piratesTick(s: State) {
  if (Date.now() - lastCheck < PIRATE_CHECK_MS) return;
  lastCheck = Date.now();
  const carte = await api.galaxy();
  const counts = new Map(carte.systemes.map((x) => [x.system, x.pirates ?? 0]));
  const changed = [...counts].filter(([sys, n]) => !started || n !== (lastCounts.get(sys) ?? 0)).map(([sys]) => sys);
  lastCounts = counts;
  const fresh: Pirate[] = [];
  for (const sys of changed) if ((counts.get(sys) ?? 0) > 0) fresh.push(...await readSystem(sys));
  // Disparues : plus dans un système relu, ou expirées
  for (const [k, p] of known) {
    const relu = changed.includes(p.system);
    if ((relu && !fresh.some((f) => key(f) === k)) || (p.expireA && s.now > p.expireA)) { known.delete(k); log("Cache pirate partie", k); }
  }
  const news = fresh.filter((p) => !known.has(key(p)));
  for (const p of fresh) known.set(key(p), p);
  if (!started) {
    started = true;
    const all = [...known.values()].sort((a, b) => a.system - b.system);
    if (all.length) alert(`☠ Caches pirates actuelles (${all.length}) :\n${all.map((p) => pirateLine(p, s.now)).join("\n")}`);
    return;
  }
  for (const p of news.sort((a, b) => a.system - b.system)) {
    const msg = `🏴‍☠️ NOUVELLE CACHE : ${pirateLine(p, s.now)}`;
    alert(msg);
    await postDiscord(msg); // Discord : uniquement les alertes pirates
  }
}

export function piratesSummary(s: State): string {
  const all = [...known.values()].sort((a, b) => a.system - b.system || a.position - b.position);
  if (!all.length) return `Aucune cache pirate connue (dernier relevé il y a ${fmtDur(Date.now() - lastCheck)}).`;
  return [`☠ Caches pirates (${all.length}) — relevé il y a ${fmtDur(Date.now() - lastCheck)}`, ...all.map((p) => pirateLine(p, s.now))].join("\n");
}
export const knownPirateAt = (system: number, position: number) => [...known.values()].find((p) => p.system === system && p.position === position);
