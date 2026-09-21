// Expéditions depuis Père vers la position 16 de son système (state.expedition.position), durée `heures` [BUNDLE].
//   /explo opti <h>  → 10 éclaireurs + 100 GT
//   /explo 911 [h]   → (2 h par défaut) tous les éclaireurs + GT + vaisseaux de bataille + croiseurs, toutes les ressources embarquables,
//                      en gardant EXPLO_DEUT_KEEP (80 000) de deutérium sur Père pour être sûr de partir.
import type { State } from "./spacek-client.ts";
import { PERE, capacity, fillCargo, fmtNum, num, pere, prepareFleet, type FleetPlan } from "./core.ts";

export const EXPLO_DEUT_KEEP = num("EXPLO_DEUT_KEEP", 80_000);
export const EXPLO_911_HOURS = num("EXPLO_911_HOURS", 2);
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
  const plan = prepareFleet(s, { from: PERE, mission: "expedition", coords, ships, cargo, heures, label: `🧭 Expédition ${kind}` });
  plan.summary += `\nDurée ${heures} h (max ${e.maxHours}) · quota ${e.lanceesAujourdhui + 1}/${e.maxPerPlayerPer24h} aujourd'hui · slots expé ${e.inFlight + 1}/${e.slots}` +
    (kind === "911" ? `\nDeutérium gardé sur Père : ${fmtNum(Math.floor(p.resources.deuterium) - cargo.deuterium)} (min ${fmtNum(EXPLO_DEUT_KEEP)})` : "");
  return plan;
}
