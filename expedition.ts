// Expéditions depuis Père vers la position 16 de son système (state.expedition.position), durée `holdHours` [BUNDLE 02/10 :
// `heures` ne sert qu'à la garde sur une balise — envoyé par erreur jusque-là, le serveur l'ignorait et l'expédition durait 0 h].
//   /explo opti <h>  → 10 éclaireurs + 100 GT
//   /explo 911 [h]   → (2 h par défaut) tous les éclaireurs + GT + vaisseaux de bataille + croiseurs, toutes les ressources embarquables,
//                      en gardant EXPLO_DEUT_KEEP (80 000) de deutérium sur Père pour être sûr de partir.
//   flag `explo` (/autoexplo on) → toujours UNE expédition opti de EXPLO_AUTO_HOURS (6 h) : la suivante part quand la précédente est rentrée.
import type { State } from "./spacek-client.ts";
import {
  PERE, alert, capacity, etaStr, fillCargo, flags, fleetResultStr, fmtDur, fmtNum, isPaused, num, pere, prepareFleet, sendFleet, shipsStr, type FleetPlan,
} from "./core.ts";
import { parseThreats, threatenedPlanetIds } from "./threats.ts";

export const EXPLO_DEUT_KEEP = num("EXPLO_DEUT_KEEP", 80_000);
export const EXPLO_911_HOURS = num("EXPLO_911_HOURS", 2);
export const EXPLO_AUTO_HOURS = num("EXPLO_AUTO_HOURS", 6);
const EXPLO_AUTO_EVAL_MS = 60_000;      // une évaluation par minute au plus
const EXPLO_AUTO_SENT_MS = 5 * 60_000;  // après un envoi réussi : pas de nouvel envoi avant que l'état ait pu refléter l'expédition en vol
const EXPLO_AUTO_RETRY_MS = 15 * 60_000; // après un envoi refusé par le jeu
const SHIPS_911 = ["pathfinder", "largeCargo", "battleship", "cruiser"];

function checkQuota(s: State) {
  const e = s.expedition;
  if (!e?.unlocked) throw new Error("Expéditions non débloquées");
  const p = pere(s);
  if (e.slots - e.inFlight <= 0) throw new Error(`Aucun slot d'expédition libre (${e.inFlight}/${e.slots} en vol)`);
  if (e.lanceesAujourdhui >= e.maxPerPlayerPer24h) throw new Error(`Quota 24 h atteint (${e.lanceesAujourdhui}/${e.maxPerPlayerPer24h}), reset à ${e.heureDeReset} h`);
  if ((e.saturatedSystems ?? []).includes(p.coords.system)) throw new Error(`Système ${p.coords.system} saturé pour les expéditions aujourd'hui`);
  return { e, p };
}

export function planExpedition(s: State, kind: "opti" | "911", hours?: number): FleetPlan {
  const { e, p } = checkQuota(s);
  if (kind === "opti" && hours == null) throw new Error("Usage : /explo opti <heures>");
  const heures = Math.max(1, Math.min(hours ?? EXPLO_911_HOURS, e.maxHours)); // 911 sans durée : 2 h (décision utilisateur)
  const coords = { system: p.coords.system, position: e.position };
  let ships: Record<string, number>;
  let cargo = { metal: 0, crystal: 0, deuterium: 0 };
  if (kind === "opti") ships = { pathfinder: 10, largeCargo: 100 };
  else {
    ships = Object.fromEntries(SHIPS_911.map((k) => [k, p.ships[k] ?? 0]).filter(([, n]) => (n as number) > 0));
    if (!Object.keys(ships).length) throw new Error("Aucun éclaireur / GT / vaisseau de bataille / croiseur sur Père");
    cargo = fillCargo(p.resources, capacity(ships), EXPLO_DEUT_KEEP);
  }
  const plan = prepareFleet(s, { from: PERE, mission: "expedition", coords, ships, cargo, holdHours: heures, label: `🧭 Expédition ${kind}` });
  plan.summary += `\nDurée ${heures} h (max ${e.maxHours}) · quota ${e.lanceesAujourdhui + 1}/${e.maxPerPlayerPer24h} aujourd'hui · slots expé ${e.inFlight + 1}/${e.slots}` +
    (kind === "911" ? `\nDeutérium gardé sur Père : ${fmtNum(Math.floor(p.resources.deuterium) - cargo.deuterium)} (min ${fmtNum(EXPLO_DEUT_KEEP)})` : "");
  return plan;
}

// ---------- Expédition permanente (flag explo, /autoexplo) ----------
/** lancer = tout est libre, `plan` prêt · vol = une expédition est encore en vol (ou pas rentrée) · menace = Père menacée (le fleet-save a besoin
 *  des vaisseaux) · attente = bloqué (quota, slot, système saturé, vaisseaux manquants…), `why` = raison. */
export type AutoExploDecision = { status: "lancer"; plan: FleetPlan } | { status: "vol" } | { status: "menace" } | { status: "attente"; why: string };
/** Calcul pur (aucun POST, aucune mutation de s) : une seule expédition à la fois, jusqu'au retour complet de la précédente. */
export function autoExploDecision(s: State, threatened: Set<string>): AutoExploDecision {
  if (!s.expedition?.unlocked) return { status: "attente", why: "Expéditions non débloquées" };
  if (s.expedition.inFlight > 0 || (s.fleets ?? []).some((f) => f.mission === "expedition")) return { status: "vol" };
  if (threatened.has(PERE)) return { status: "menace" };
  try { return { status: "lancer", plan: planExpedition(s, "opti", EXPLO_AUTO_HOURS) }; }
  catch (e: any) { return { status: "attente", why: e.message }; }
}

let exploEvalAt = 0, exploSentAt = 0, exploKoAt = 0;
let exploAlerted = ""; // dernière raison d'attente signalée : pas deux fois la même, réarmée dès que le blocage est levé
/** Appelé depuis watch() : lance l'expédition opti quand aucune n'est en vol. Ne POSTe jamais en boucle (garde 1 min, 5 min après un succès, 15 min après un échec). */
export async function autoExploTick(s: State, threatened: Set<string>) {
  if (!flags.explo || !s.expedition?.unlocked) return; // /pause coupe le flag
  const now = Date.now();
  if (now - exploEvalAt < EXPLO_AUTO_EVAL_MS) return;
  exploEvalAt = now;
  const d = autoExploDecision(s, threatened);
  if (d.status === "vol") { exploAlerted = ""; return; }
  if (d.status === "menace") return;
  if (now - exploSentAt < EXPLO_AUTO_SENT_MS || now - exploKoAt < EXPLO_AUTO_RETRY_MS) return;
  if (d.status === "attente") {
    const msg = `🧭 Expédition auto en attente : ${d.why}`;
    if (exploAlerted !== msg) { exploAlerted = msg; alert(msg); }
    return;
  }
  exploAlerted = "";
  const { plan } = d;
  const what = `${shipsStr(plan.payload.ships)} · ${plan.payload.holdHours} h sur place`;
  let res;
  try { res = await sendFleet(plan, new Set(s.fleets.map((f) => f.id))); }
  catch (e: any) { exploKoAt = Date.now(); alert(`🧭 Expédition auto KO : ${e.message}\nNouvel essai dans ${fmtDur(EXPLO_AUTO_RETRY_MS)}`); return; }
  exploSentAt = Date.now();
  alert(`🧭 Expédition auto lancée : ${what}\n${fleetResultStr(res)}`);
  // État local recalé jusqu'au prochain poll (les ticks suivants du même passage)
  s.expedition.inFlight++; s.fleetSlots.used++;
  const p = pere(s);
  for (const [k, n] of Object.entries(plan.payload.ships)) p.ships[k] -= n;
}

// ---------- Résumé Telegram ----------
/** État de l'expédition permanente : on/off, flotte et durée, expédition en vol (arrivée / retour), quota du jour, blocage éventuel. */
export function autoExploSummary(s: State): string {
  const e = s.expedition, on = flags.explo, now = s.now ?? Date.now();
  const head = `🧭 Expédition auto : ${on ? "ON" : "OFF"}${isPaused() ? " ⏸ EN PAUSE (/resume)" : ""}`;
  if (!e?.unlocked) return `${head}\nExpéditions non débloquées.`;
  const heures = Math.max(1, Math.min(EXPLO_AUTO_HOURS, e.maxHours));
  const lines = [head, `Flotte : 10 éclaireurs + 100 GT · ${heures} h, depuis Père vers la position ${e.position}`];
  const vol = (s.fleets ?? []).filter((f) => f.mission === "expedition");
  const d = autoExploDecision(s, threatenedPlanetIds(s, parseThreats(s)));
  if (vol.length || e.inFlight > 0) {
    lines.push(`En vol : ${e.inFlight}/${e.slots}` + vol.map((f) =>
      ` · flotte ${f.id}${f.arrivesAt && f.arrivesAt > now ? ` arrive dans ${etaStr(f.arrivesAt - now)}` : ""}${f.returnsAt && f.returnsAt > now ? ` · retour dans ${etaStr(f.returnsAt - now)}` : ""}`).join(""));
    lines.push(on ? "La suivante partira au retour de celle-ci." : "Une fois activée, la suivante partira au retour de celle-ci.");
  } else lines.push("Aucune expédition en vol.");
  lines.push(`Quota du jour : ${e.lanceesAujourdhui}/${e.maxPerPlayerPer24h} (reset à ${e.heureDeReset} h)`);
  if (d.status === "attente") lines.push(`Bloqué : ${d.why}`);
  else if (d.status === "menace") lines.push("Père menacée : en attente (le fleet-save a besoin des vaisseaux).");
  else if (d.status === "lancer") lines.push(on ? "Prêt : part à la prochaine évaluation (moins d'une minute)." : "Tout est libre : partirait dès l'activation.");
  if (on && exploKoAt && Date.now() - exploKoAt < EXPLO_AUTO_RETRY_MS) lines.push(`Dernier envoi refusé : nouvel essai dans ${fmtDur(exploKoAt + EXPLO_AUTO_RETRY_MS - Date.now())}.`);
  return lines.join("\n");
}
