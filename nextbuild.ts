// /next : une construction mise en attente par planète, lancée DÈS que la file se libère
// (pas de délai de grâce, pas de priorités : c'est un ordre manuel, typiquement pour enchaîner la nuit).
// Persisté dans next-build.json → survit aux redémarrages de pm2.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Planet, State } from "./spacek-client.ts";
import { alert, api, fmtDur, log, resStr } from "./core.ts";

const FILE = "next-build.json";
const RETRY_MS = 60_000; // ressources manquantes / refus : on retente au plus une fois par minute

export type NextOrder = { key: string; name: string; at: number };
let orders: Record<string, NextOrder> = {};
const lastTry = new Map<string, number>();
const warned = new Map<string, string>(); // planetId → dernier message d'erreur signalé

try { if (existsSync(FILE)) orders = JSON.parse(readFileSync(FILE, "utf8")); }
catch (e: any) { console.error("next-build.json illisible :", e.message); }
function persist() {
  try { writeFileSync(`${FILE}.tmp`, JSON.stringify(orders, null, 2)); renameSync(`${FILE}.tmp`, FILE); }
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

export type BuildChoice = { key: string; name: string; level: number; cost: { metal: number; crystal: number; deuterium: number }; durationMs: number; locked: boolean };
/** Options constructibles d'une planète, pour les boutons Telegram. */
export const buildChoices = (p: Planet): BuildChoice[] =>
  (p.buildOptions ?? []).map((b: any) => ({
    key: b.key as string, name: b.name as string, level: b.level as number, cost: b.cost,
    durationMs: b.durationMs as number, locked: !!b.locked || (b.missing ?? []).length > 0,
  }));

/** À chaque poll : si la file est vide et qu'un ordre attend, on le lance immédiatement. */
export async function nextBuildTick(s: State) {
  for (const p of s.planets) {
    const o = orders[p.id];
    if (!o || p.buildQueue) continue;
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
  const lines = s.planets.map((p) => {
    const o = orders[p.id];
    const cur = p.buildQueue ? `🏗 ${p.buildQueue.key} niv. ${p.buildQueue.targetLevel} (fin dans ${fmtDur(p.buildQueue.finishesAt - s.now)})` : "file libre";
    const opt = o ? (p.buildOptions ?? []).find((b: any) => b.key === o.key) : null;
    return `• ${p.name} — ${cur}\n  ${o ? `⏭ en attente : ${o.name}${opt ? ` niv. ${opt.level + 1} · ${resStr(opt.cost)}` : ""}` : "⏭ rien en attente"}`;
  });
  return ["⏭ Prochaines constructions (lancées dès que la file se libère)", ...lines].join("\n");
}
