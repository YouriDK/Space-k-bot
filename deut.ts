// Plafond de deut sur les colonies (flag deut, /autodeut) : tout ce qui dépasse DEUT_CAP sur une planète autre que Père est renvoyé à Père
// avec les transporteurs SUR LA COLONIE (GT d'abord, PT en complément, une seule flotte, cargaison = deut seul). Pas de réduction de cargaison :
// le carburant est pris sur les DEUT_CAP qui restent. Aucun état persisté (le stock de la colonie fait foi) ; une évaluation par minute au plus.
// Cohérent avec l'auto-ravitaillement : quand le flag est actif, supplyTarget() plafonne sa cible de deut à DEUT_CAP (supply.ts).
import type { Planet, State } from "./spacek-client.ts";
import { PERE, CARGO, alert, flags, fleetResultStr, fmtNum, isPaused, log, num, prepareFleet, same, sendFleet, shipsStr } from "./core.ts";
import { planetReserved, reservedWhy } from "./reserve.ts";
import { parseThreats, threatenedPlanetIds } from "./threats.ts";

// ================= CONFIG =================
export const DEUT_CAP = num("DEUT_CAP", 150_000);               // plafond de deut sur chaque planète autre que Père
export const DEUT_COLLECT_MIN = num("DEUT_COLLECT_MIN", 10_000); // pas de vol pour moins que ça
const DEUT_EVAL_MS = 60_000;     // une évaluation par minute au plus
const DEUT_RETRY_MS = 15 * 60_000; // après un envoi refusé par le jeu, délai avant de réessayer vers la même colonie
// ==========================================

const capStr = `${DEUT_CAP / 1000}k`;

// ---------- Calcul pur ----------
/** envoi = flotte à faire partir · rien = sous le plafond (ou excédent < DEUT_COLLECT_MIN) · attente = bloqué (menace, réservée, transport en route,
 *  transporteurs, slots) → `noShip` marque le cas « excédent mais aucun transporteur sur place ». */
export type DeutStatus = "envoi" | "rien" | "attente";
export type DeutStep = { p: Planet; status: DeutStatus; deut: number; excess: number; ships: Record<string, number>; soute: number; noShip?: boolean; why?: string };
/** Calcul pur (aucun POST, aucune mutation de s) : que partirait-il de chaque colonie (Père ignorée, dans l'ordre de s.planets), sinon pourquoi.
 *  Les colonies se partagent les slots de flotte (compteur local). */
export function planDeutAuto(s: State, threatened: Set<string>): DeutStep[] {
  const pere = s.planets.find((p) => p.id === PERE);
  const steps: DeutStep[] = [];
  let used = s.fleetSlots.used;
  for (const p of s.planets.filter((x) => x.id !== PERE)) {
    const excess = Math.max(0, Math.floor(p.resources.deuterium) - DEUT_CAP);
    const base = { p, deut: 0, excess, ships: {} as Record<string, number>, soute: 0 };
    const wait = (why: string) => steps.push({ ...base, status: "attente", why });
    if (!pere) { wait("Père introuvable"); continue; }
    if (threatened.has(PERE)) { wait("Père menacée"); continue; }
    if (threatened.has(p.id)) { wait("colonie menacée"); continue; }
    if (planetReserved(p.id)) { wait(reservedWhy(p.id)); continue; } // /fleetbuild ou financement de bâtiment
    // Aller OU retour : pendant le trajet retour les transporteurs ne sont pas à quai, ce n'est pas « aucun transporteur sur place »
    if (s.fleets.some((f) => f.mission === "transport" && f.origin?.planetId === p.id && (f.phase !== "outbound" || same(f.target?.coords, pere.coords)))) { wait("transport déjà en cours depuis la colonie"); continue; }
    if (excess < DEUT_COLLECT_MIN) { steps.push({ ...base, status: "rien", why: excess ? `excédent ${fmtNum(excess)} < ${fmtNum(DEUT_COLLECT_MIN)}` : `sous le plafond de ${capStr}` }); continue; }
    // Transporteurs sur place : GT d'abord, PT en complément, une seule flotte
    const ships: Record<string, number> = {};
    let cap = 0;
    for (const k of ["largeCargo", "smallCargo"]) {
      const n = Math.min(p.ships[k] ?? 0, Math.ceil(Math.max(0, excess - cap) / CARGO[k]));
      if (n > 0) { ships[k] = n; cap += n * CARGO[k]; }
    }
    if (!cap) { steps.push({ ...base, status: "attente", noShip: true, why: "aucun transporteur sur place" }); continue; }
    if (used >= s.fleetSlots.total) { steps.push({ ...base, status: "attente", ships, soute: cap, why: `aucun slot libre (${used}/${s.fleetSlots.total})` }); continue; }
    used++;
    steps.push({ ...base, status: "envoi", ships, soute: cap, deut: Math.min(excess, cap) });
  }
  return steps;
}

// ---------- Tick (appelé depuis watch(), au plus une fois par minute) ----------
let lastEval = 0;
const deutKo = new Map<string, number>();    // planetId → dernier envoi refusé : on attend DEUT_RETRY_MS avant de réessayer
const deutLogged = new Map<string, string>(); // planetId → dernière ligne logguée (blocage) : pas la même à chaque tick
const deutNoShip = new Set<string>();         // colonies déjà alertées « aucun transporteur » (réarmé sous le plafond ou avec transporteurs)
export async function autoDeutTick(s: State, threatened: Set<string>) {
  if (!flags.deut) return; // off ou /pause
  const now = Date.now();
  if (now - lastEval < DEUT_EVAL_MS) return;
  lastEval = now;
  const pere = s.planets.find((p) => p.id === PERE);
  if (!pere || threatened.has(PERE)) return;
  const once = (id: string, msg: string) => { if (deutLogged.get(id) !== msg) { deutLogged.set(id, msg); log(msg); } };
  const steps = planDeutAuto(s, threatened);
  for (const id of [...deutNoShip]) if (!steps.some((st) => st.p.id === id && st.noShip)) deutNoShip.delete(id); // sous le plafond ou transporteurs arrivés → on réarme
  for (const st of steps) if (st.status !== "attente") deutLogged.delete(st.p.id);
  for (const { p, status, deut, excess, ships, noShip, why } of steps) {
    if (status === "rien") continue;
    if (noShip) {
      if (!deutNoShip.has(p.id)) { deutNoShip.add(p.id); alert(`⛽ ${p.name} : ${fmtNum(excess)} de deut au-dessus de ${capStr} mais aucun transporteur sur place — déploie des GT : /deploy pere ${p.name} largeCargo=2`); }
      continue;
    }
    if (status === "attente") { once(p.id, `DEUT ${p.name} : ${why}`); continue; }
    if (now - (deutKo.get(p.id) ?? 0) < DEUT_RETRY_MS) continue;
    const what = `${p.name} → Père : ${shipsStr(ships)} · ${fmtNum(deut)} de deut (reste ${fmtNum(DEUT_CAP)})`;
    const res = await Promise.resolve().then(() => sendFleet(
      prepareFleet(s, { from: p.id, mission: "transport", coords: pere.coords, ships, cargo: { metal: 0, crystal: 0, deuterium: deut }, speedPercent: 100, label: "⛽ Deut → Père" }),
      new Set(s.fleets.map((f) => f.id))))
      .catch((e) => { deutKo.set(p.id, Date.now()); alert(`⛽ DEUT KO ${what}\n${e.message}\nNouvel essai dans 15 min`); return null; });
    if (!res) continue; // les colonies suivantes sont quand même servies
    deutKo.delete(p.id);
    alert(`⛽ ${what}\n${fleetResultStr(res)}`);
    // État local recalé jusqu'au prochain poll (carburant inconnu → non décompté)
    p.resources.deuterium -= deut;
    for (const [k, n] of Object.entries(ships)) p.ships[k] -= n;
    s.fleetSlots.used++;
  }
}

// ---------- Résumé Telegram ----------
/** /autodeut : on/off, plafond, puis une ligne par colonie (deut, excédent, transporteurs sur place, ce qui partirait ou pourquoi rien). */
export function autoDeutSummary(s: State): string {
  const threatened = threatenedPlanetIds(s, parseThreats(s));
  const lines = planDeutAuto(s, threatened).map(({ p, status, deut, excess, ships, why }) => {
    const sur = [["largeCargo", "GT"], ["smallCargo", "PT"]].map(([k, l]) => `${p.ships[k] ?? 0} ${l}`).join(" + ");
    const part = status === "envoi" ? `partirait : ${shipsStr(ships)} · ${fmtNum(deut)} de deut` : status === "rien" ? `rien (${why})` : `bloqué : ${why}`;
    return `• ${p.name} : deut ${fmtNum(Math.floor(p.resources.deuterium))} · excédent ${fmtNum(excess)} · sur place ${sur}\n  ${part}`;
  });
  return [
    `⛽ Deut → Père : ${flags.deut ? "on" : "off"}${isPaused() ? " ⏸ EN PAUSE (/resume)" : ""} · plafond ${fmtNum(DEUT_CAP)} par colonie · envoi dès ${fmtNum(DEUT_COLLECT_MIN)} d'excédent · GT puis PT sur place`,
    ...(lines.length ? lines : ["Aucune colonie."]),
  ].join("\n");
}
