// Auto-ravitaillement depuis Père, activé PAR COLONIE (supply.json) : une vérification toutes les SUPPLY_EVERY_H heures par colonie active.
// À l'échéance, la colonie est complétée jusqu'à SUPPLY_TARGET (au millier près, sans plafond de capacité : le transport peut dépasser
// la capacité), GT d'abord puis PT en complément, une seule flotte. Activer une colonie la rend due tout de suite.
// Échéance consommée quand la vérification a abouti (envoi parti, ou rien à envoyer) ; sinon (menace, transport en route, pas de
// transporteur, pas de slot, envoi refusé) on réessaie aux ticks suivants. /pause suspend tout sans toucher aux activations.
// Persisté dans supply.json → un redémarrage ne relance pas de passage avant l'échéance.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Planet, Res, State } from "./spacek-client.ts";
import {
  PERE, CARGO, DEUT_RESERVE, alert, capacity, fillCargo, fleetResultStr, fmtDur, fmtNum, isPaused, log, num, same, sendFleetFuelSafe, shipsStr, xy,
} from "./core.ts";
import { parseThreats, threatenedPlanetIds } from "./threats.ts";

// ================= CONFIG =================
// SUPPLY = surcharge par planète, fusionnée sur la cible par défaut.
export const SUPPLY_TARGET: Res = {
  metal: num("SUPPLY_TARGET_METAL", 500_000), crystal: num("SUPPLY_TARGET_CRYSTAL", 350_000), deuterium: num("SUPPLY_TARGET_DEUT", 150_000),
};
export const SUPPLY: Record<string, Partial<Res>> = {
  // pl_rn: { metal: 100_000, crystal: 50_000, deuterium: 20_000 },  // Planète Fils
};
export const supplyTarget = (planetId: string): Res => ({ ...SUPPLY_TARGET, ...SUPPLY[planetId] });
export const SUPPLY_EVERY_H = num("SUPPLY_EVERY_H", 12);
const SUPPLY_EVERY_MS = SUPPLY_EVERY_H * 3_600_000;
const SUPPLY_MIN_SEND = num("SUPPLY_MIN_SEND", 20_000); // pas de vol pour moins que ça
const SUPPLY_RETRY_MS = 15 * 60_000;  // après un envoi refusé par le jeu, délai avant de réessayer vers la même colonie
const FILE = "supply.json";
// ==========================================

const RES_KEYS: (keyof Res)[] = ["metal", "crystal", "deuterium"];
const resFmt = (r: Res) => `M ${fmtNum(r.metal)} · C ${fmtNum(r.crystal)} · D ${fmtNum(r.deuterium)}`;
export const supplyTargetStr = (t: Res = SUPPLY_TARGET) => `${t.metal / 1000}k M / ${t.crystal / 1000}k C / ${t.deuterium / 1000}k D`;
const everyStr = `${SUPPLY_EVERY_H} h`;

// ---------- État par colonie (supply.json) ----------
export type SupplyPlanet = { enabled: boolean; lastAt: number }; // lastAt = dernière vérification aboutie (ms), 0 = due tout de suite
let conf: Record<string, SupplyPlanet> = {};
export function loadSupply() {
  try {
    if (!existsSync(FILE)) { conf = {}; return; }
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    conf = Object.fromEntries(Object.entries(raw ?? {}).map(([id, v]: [string, any]) => [id, { enabled: v?.enabled === true, lastAt: Number(v?.lastAt) || 0 }]));
  } catch (e: any) { console.error("supply.json illisible :", e.message); }
}
loadSupply();
function persist() {
  try { writeFileSync(`${FILE}.tmp`, JSON.stringify(conf, null, 2)); renameSync(`${FILE}.tmp`, FILE); }
  catch (e: any) { log("supply.json KO :", e.message); }
}
export const getSupply = (planetId: string): SupplyPlanet => ({ ...(conf[planetId] ?? { enabled: false, lastAt: 0 }) });
export const supplyEnabled = (planetId: string) => planetId !== PERE && !!conf[planetId]?.enabled;
export const supplyDueAt = (planetId: string) => getSupply(planetId).lastAt + SUPPLY_EVERY_MS;
/** Activation : la colonie devient due tout de suite (lastAt = 0). Désactivation : lastAt conservé. */
export function setSupplyEnabled(planetId: string, v: boolean): SupplyPlanet {
  if (planetId === PERE) throw new Error("Père est la source du ravitaillement");
  conf[planetId] = { ...getSupply(planetId), enabled: v, ...(v ? { lastAt: 0 } : {}) };
  supplyKo.delete(planetId); supplyLogged.delete(planetId);
  log("AUTOSUPPLY", planetId, "=", v);
  persist();
  return getSupply(planetId);
}
const consume = (planetId: string) => { conf[planetId] = { ...getSupply(planetId), lastAt: Date.now() }; persist(); };

// ---------- Calcul pur ----------
/** envoi = flotte à faire partir · rien = vérification aboutie sans envoi (rien ne manque / Père trop pauvre) → échéance consommée ·
 *  attente = bloqué (menace, transport en route, transporteurs, slots) → on réessaie au tick suivant. */
export type SupplyStatus = "envoi" | "rien" | "attente";
export type SupplyStep = { p: Planet; status: SupplyStatus; ships: Record<string, number>; cargo: Res; need: Res; why?: string };
/** Calcul pur d'un passage pour les colonies `ids` (aucun POST, aucune mutation de s) : manque = cible − stock arrondi au millier
 *  supérieur, don de Père au millier inférieur (deut : au-delà de DEUT_RESERVE). Les colonies se partagent stock, transporteurs et
 *  slots de Père (copies locales décrémentées). Une étape par colonie demandée (Père et ids inconnus ignorés), dans l'ordre de s.planets. */
export function planSupplyAuto(s: State, threatened: Set<string>, ids: string[]): SupplyStep[] {
  const pere = s.planets.find((p) => p.id === PERE);
  const cols = s.planets.filter((p) => p.id !== PERE && ids.includes(p.id));
  const zero: Res = { metal: 0, crystal: 0, deuterium: 0 };
  const stock: Res = { ...(pere?.resources ?? zero) }, quai: Record<string, number> = { ...pere?.ships }, steps: SupplyStep[] = [];
  let used = s.fleetSlots.used;
  for (const p of cols) {
    const t = supplyTarget(p.id);
    const need: Res = { ...zero };
    for (const k of RES_KEYS) need[k] = Math.ceil(Math.max(0, t[k] - Math.floor(p.resources[k])) / 1000) * 1000; // pas de plafond de capacité
    const wait = (why: string) => steps.push({ p, status: "attente", ships: {}, cargo: { ...zero }, need, why });
    if (!pere) { wait("Père introuvable"); continue; }
    if (threatened.has(PERE)) { wait("Père menacée"); continue; }
    if (threatened.has(p.id)) { wait("colonie menacée"); continue; } // jamais vers une planète menacée
    if (s.fleets.some((f) => f.mission === "transport" && f.phase === "outbound" && same(f.target?.coords, p.coords))) { wait("transport déjà en route"); continue; }
    const dispo = (k: keyof Res) => Math.floor(Math.max(0, stock[k] - (k === "deuterium" ? DEUT_RESERVE : 0)) / 1000) * 1000;
    let cargo: Res = { metal: Math.min(need.metal, dispo("metal")), crystal: Math.min(need.crystal, dispo("crystal")), deuterium: Math.min(need.deuterium, dispo("deuterium")) };
    const total = cargo.metal + cargo.crystal + cargo.deuterium;
    if (total < SUPPLY_MIN_SEND) {
      const manque = need.metal + need.crystal + need.deuterium;
      steps.push({ p, status: "rien", ships: {}, cargo, need, why: manque < SUPPLY_MIN_SEND ? "rien ne manque" : `Père trop pauvre (${fmtNum(total)} disponibles)` });
      continue;
    }
    // Transporteurs à quai sur Père : GT d'abord, PT en complément, une seule flotte
    const ships: Record<string, number> = {};
    let cap = 0;
    for (const k of ["largeCargo", "smallCargo"]) {
      const n = Math.min(quai[k] ?? 0, Math.ceil(Math.max(0, total - cap) / CARGO[k]));
      if (n > 0) { ships[k] = n; cap += n * CARGO[k]; }
    }
    if (!cap) { steps.push({ p, status: "attente", ships, cargo, need, why: "aucun transporteur à quai sur Père" }); continue; }
    if (used >= s.fleetSlots.total) { steps.push({ p, status: "attente", ships, cargo, need, why: `aucun slot libre (${used}/${s.fleetSlots.total})` }); continue; }
    if (cap < total) cargo = fillCargo(cargo, cap, 0); // soute insuffisante : on réduit (priorité deut > cristal > métal), le reste au passage suivant
    steps.push({ p, status: "envoi", ships, cargo, need });
    used++;
    for (const k of RES_KEYS) stock[k] -= cargo[k];
    for (const [k, n] of Object.entries(ships)) quai[k] -= n;
  }
  return steps;
}

// ---------- Tick (appelé depuis watch(), au plus une fois par minute) ----------
const supplyLogged = new Map<string, string>(); // planetId → dernière ligne logguée (blocage) : pas la même à chaque tick
const supplyKo = new Map<string, number>();     // planetId → dernier envoi refusé : on attend SUPPLY_RETRY_MS avant de réessayer
export async function supplyTick(s: State, threatened: Set<string>) {
  if (isPaused()) return; // /pause : rien, échéances intactes
  const now = Date.now();
  const due = s.planets.filter((p) => supplyEnabled(p.id) && now >= supplyDueAt(p.id) && now - (supplyKo.get(p.id) ?? 0) >= SUPPLY_RETRY_MS).map((p) => p.id);
  for (const id of [...supplyLogged.keys()]) if (!due.includes(id)) supplyLogged.delete(id); // plus due (servie, désactivée) → on réarme
  if (!due.length) return;
  const pere = s.planets.find((p) => p.id === PERE);
  const once = (id: string, msg: string) => { if (supplyLogged.get(id) !== msg) { supplyLogged.set(id, msg); log(msg); } };
  for (const { p, status, ships, cargo, why } of planSupplyAuto(s, threatened, due)) {
    if (status === "attente") { once(p.id, `SUPPLY ${p.name} : ${why} → nouvel essai au prochain tick`); continue; }
    if (status === "rien") { supplyLogged.delete(p.id); consume(p.id); log(`SUPPLY ${p.name} : ${why} → prochain passage dans ${everyStr}`); continue; }
    if (!pere) continue;
    const what = `Père → ${p.name} : ${shipsStr(ships)} · ${resFmt(cargo)}`;
    supplyLogged.delete(p.id);
    // Rattrapage carburant : deut réel de Père + métal/cristal prévus → la 2e tentative n'emporte jamais plus que prévu
    const sup = await sendFleetFuelSafe({ planetId: PERE, mission: "transport", coords: xy(p.coords), ships, cargo, speedPercent: 100 },
      { ...cargo, deuterium: pere.resources.deuterium }, capacity(ships), new Set(s.fleets.map((f) => f.id)))
      .catch((e) => { supplyKo.set(p.id, Date.now()); alert(`📦 SUPPLY KO ${what}\n${e.message}\nNouvel essai dans ${fmtDur(SUPPLY_RETRY_MS)}`); return null; });
    if (!sup) continue; // échéance non consommée ; les colonies suivantes sont quand même servies
    supplyKo.delete(p.id);
    consume(p.id);
    alert(`📦 SUPPLY ${what}${sup.note ? `\n${sup.note}` : ""}\n${fleetResultStr(sup.res)}\nProchain passage dans ${everyStr}`);
    // État local recalé jusqu'au prochain poll (collect / autobuild du même tick) ; carburant inconnu → non décompté
    for (const k of RES_KEYS) pere.resources[k] -= cargo[k];
    for (const [k, n] of Object.entries(ships)) pere.ships[k] -= n;
    s.fleetSlots.used++;
  }
}

// ---------- Résumé Telegram ----------
/** État par colonie (ou d'une seule) : on/off, prochain passage, manque actuel et ce qui partirait maintenant (calcul isolé par colonie). */
export function supplySummary(s: State, only?: Planet): string {
  const threatened = threatenedPlanetIds(s, parseThreats(s));
  const cols = s.planets.filter((p) => p.id !== PERE && (!only || p.id === only.id));
  const actives = s.planets.filter((p) => supplyEnabled(p.id)).map((p) => p.name);
  const now = Date.now();
  const lines = cols.map((p) => {
    const on = supplyEnabled(p.id);
    const ko = now - (supplyKo.get(p.id) ?? 0) < SUPPLY_RETRY_MS ? supplyKo.get(p.id)! + SUPPLY_RETRY_MS : 0;
    const due = Math.max(supplyDueAt(p.id), ko);
    const next = !on ? "" : ` · prochain passage ${due <= now ? "dans la minute" : `dans ${fmtDur(due - now)}`}${ko && ko >= supplyDueAt(p.id) ? " (envoi refusé, nouvel essai)" : ""}`;
    const [st] = planSupplyAuto(s, threatened, [p.id]);
    const n = st.need.metal + st.need.crystal + st.need.deuterium;
    const t = supplyTarget(p.id);
    const cible = SUPPLY[p.id] ? ` · cible ${supplyTargetStr(t)}` : "";
    const manque = n ? `manque ${resFmt(st.need)}` : "rien ne manque";
    const part = st.status === "envoi" ? `partirait : ${shipsStr(st.ships)} · ${resFmt(st.cargo)}` : st.status === "rien" ? (n ? `rien ne partirait (${st.why})` : "") : `bloqué : ${st.why}`;
    return `• ${p.name} [${on ? "on" : "off"}]${next}${cible}\n  ${[manque, part].filter(Boolean).join(" → ")}`;
  });
  if (only) return [`📦 Auto-ravitaillement${isPaused() ? " ⏸ EN PAUSE (/resume)" : ""} · cible ${supplyTargetStr()} · toutes les ${everyStr}`, ...lines].join("\n");
  return [
    `📦 Auto-ravitaillement${isPaused() ? " ⏸ EN PAUSE (/resume)" : ""} : ${actives.join(", ") || "aucune colonie activée"}`,
    `Cible ${supplyTargetStr()} (au millier) · une vérification toutes les ${everyStr} par colonie · GT puis PT depuis Père`,
    ...lines,
  ].join("\n");
}
