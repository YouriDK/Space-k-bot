// Financement des bâtiments des colonies par Père (/autobuild finance on|off, allumé par défaut, réglage dans build-plan.json).
// Quand une colonie à autobuild activé a un « besoin » (autobuild.ts : premier candidat écarté faute de ressources), une commande est
// créée (une au plus par planète, jamais pour Père qui paie sur place) : Père livre le MANQUE (coût − stock de la colonie, recalculé à
// chaque voyage sur le stock réel) en un ou plusieurs voyages — GT puis PT à quai, stock de Père moins DEUT_RESERVE, un slot libre,
// au moins TRANSPORT_MIN_LOAD (un GT plein) par voyage sauf le dernier qui comble tout le manque (sinon on attend, une alerte) —
// puis, dès que le stock couvre le coût ACTUEL et que la file est libre, le bot lance le bâtiment (POST /build) et retire la commande.
// Dès qu'une commande existe (en route OU livrée), la planète est RÉSERVÉE (reserve.ts) jusqu'au lancement.
// Besoin disparu (niveau atteint, bâtiment lancé à la main, autobuild désactivé, plafond abaissé) : commande retirée avec alerte, les
// ressources restent sur place. Au plus un POST par minute et par commande, une alerte par raison, jamais d'abandon silencieux.
// Rien n'est envoyé vers une planète menacée ni depuis Père menacé. /pause suspend tout (flags.autobuild), commandes conservées.
// « off » : plus de nouvelle commande ; celles en cours vont au bout (/autobuild finance annule <planète> pour en retirer une).
// Persisté dans build-fund.json (écriture atomique).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Planet, Res, State } from "./spacek-client.ts";
import {
  PERE, CARGO, DEUT_RESERVE, TRANSPORT_MIN_LOAD, alert, api, etaStr, fillCargo, flags, fleetResultStr, fmtNum, log, prepareFleet, sendFleet, shipsStr,
} from "./core.ts";
import { buildCtx, financementOn, loadPlan, nextBuilding, planetPlan } from "./autobuild.ts";
import { fleetBuildOrders } from "./fleetbuild.ts";
import { setFundReserved } from "./reserve.ts";

const FILE = "build-fund.json";
const RETRY_MS = 60_000;           // au plus un POST (voyage ou /build) par minute et par commande
const DECIDE_EVERY_MS = 60_000;    // création d'une commande : une évaluation par planète et par minute
const STOCK_GRACE_MS = 2 * 60_000; // crédit d'une livraison pas encore visible : pas de nouveau voyage pendant 2 min après l'arrivée
const RES_KEYS: (keyof Res)[] = ["metal", "crystal", "deuterium"];
const zero = (): Res => ({ metal: 0, crystal: 0, deuterium: 0 });
const resFmt = (r: Res) => `M ${fmtNum(r.metal)} · C ${fmtNum(r.crystal)} · D ${fmtNum(r.deuterium)}`;
const sum = (r: Res) => r.metal + r.crystal + r.deuterium;

// ---------- Commandes (build-fund.json) ----------
/** cost / manque0 = au moment de la création (affichage) ; le manque réel est toujours recalculé sur le stock de la colonie. */
export type FundOrder = {
  planetId: string; planetName: string; key: string; name: string; next: number; cost: Res; manque0: Res; at: number;
  voyages: number; envoye: Res; fleetId?: string; arrivesAt?: number; lastArrivalAt?: number; suspendu?: boolean;
};
let orders: Record<string, FundOrder> = {};
const lastTry = new Map<string, number>();     // planetId → dernier POST
const lastDecision = new Map<string, number>(); // planetId → dernière évaluation de création
const warned = new Map<string, string>();       // planetId → dernière raison signalée (une alerte par raison)
const why = new Map<string, string>();          // planetId → raison courante, pour /plan
export function loadFund() {
  try {
    orders = {};
    if (existsSync(FILE)) {
      const raw = JSON.parse(readFileSync(FILE, "utf8"));
      orders = raw?.orders && typeof raw.orders === "object" ? raw.orders : {};
    }
  } catch (e: any) { console.error("build-fund.json illisible :", e.message); }
  setFundReserved(Object.keys(orders));
}
loadFund();
function persist() {
  setFundReserved(Object.keys(orders));
  try { writeFileSync(`${FILE}.tmp`, JSON.stringify({ orders }, null, 2)); renameSync(`${FILE}.tmp`, FILE); }
  catch (e: any) { log("build-fund.json KO :", e.message); }
}
export const fundOrders = (): FundOrder[] => Object.values(orders).map((o) => ({ ...o }));
function removeOrder(planetId: string) { delete orders[planetId]; lastTry.delete(planetId); warned.delete(planetId); why.delete(planetId); persist(); }
/** /autobuild finance annule <planète> : retire la commande (le transport n'est PAS rappelé). */
export function cancelFund(planetId: string): FundOrder | undefined {
  const o = orders[planetId];
  if (o) { removeOrder(planetId); log("FINANCEMENT annulé", o.planetName, o.key); }
  return o;
}

// ---------- Calcul pur ----------
const optOf = (p: Planet, k: string) => (p.buildOptions ?? []).find((b: any) => b.key === k);
/** Manque de la colonie pour un coût (par ressource, jamais négatif). */
export const manqueOf = (p: Planet, cost: Res): Res =>
  ({ metal: Math.max(0, Math.ceil(cost.metal) - Math.floor(p.resources.metal)), crystal: Math.max(0, Math.ceil(cost.crystal) - Math.floor(p.resources.crystal)), deuterium: Math.max(0, Math.ceil(cost.deuterium) - Math.floor(p.resources.deuterium)) });
/** Transport en vol de cette commande (id connu, sinon arrivesAt serveur pas encore passé). */
const enVol = (o: FundOrder, s: State) => {
  if (o.fleetId) { const f = s.fleets.find((x) => x.id === o.fleetId); return !!f && f.phase === "outbound"; }
  return !!o.arrivesAt && s.now < o.arrivesAt;
};
export type FundTrip = { ships: Record<string, number>; cargo: Res } | { why: string; code: string };
/** Un voyage Père → colonie pour combler `manque` : stock de Père (DEUT_RESERVE gardé), soute à quai (GT puis PT), slot libre, au moins TRANSPORT_MIN_LOAD sauf voyage qui comble tout. Aucun POST. */
export function planFundTrip(s: State, pere: Planet, manque: Res): FundTrip {
  const dispo: Res = {
    metal: Math.floor(pere.resources.metal), crystal: Math.floor(pere.resources.crystal), deuterium: Math.max(0, Math.floor(pere.resources.deuterium) - DEUT_RESERVE),
  };
  let cargo: Res = { metal: Math.min(manque.metal, dispo.metal), crystal: Math.min(manque.crystal, dispo.crystal), deuterium: Math.min(manque.deuterium, dispo.deuterium) };
  const total = sum(cargo);
  if (!total) return { code: "stock", why: `Père n'a pas de quoi livrer (Père ${resFmt(dispo)} hors réserve de deut)` };
  const ships: Record<string, number> = {};
  let cap = 0;
  for (const k of ["largeCargo", "smallCargo"]) {
    const n = Math.min(pere.ships[k] ?? 0, Math.ceil(Math.max(0, total - cap) / CARGO[k]));
    if (n > 0) { ships[k] = n; cap += n * CARGO[k]; }
  }
  if (!cap) return { code: "cargo", why: "aucun transporteur à quai sur Père" };
  if (s.fleetSlots.used >= s.fleetSlots.total) return { code: "slot", why: `aucun slot de flotte libre (${s.fleetSlots.used}/${s.fleetSlots.total})` };
  if (cap < total) cargo = fillCargo(cargo, cap, 0); // soute insuffisante : priorité deut > cristal > métal, le reste au voyage suivant
  // Voyage trop petit (carburant pour rien) : on attend, sauf s'il comble tout le manque (dernier voyage)
  if (sum(cargo) < TRANSPORT_MIN_LOAD && sum(cargo) < sum(manque))
    return { code: "min", why: `voyage trop petit : ${fmtNum(sum(cargo))} à livrer sur ${fmtNum(sum(manque))} manquants, minimum ${fmtNum(TRANSPORT_MIN_LOAD)} (un GT plein) — ${cap < total ? "pas assez de soute à quai sur Père" : "Père n'a pas assez de stock hors réserve"}` };
  return { ships, cargo };
}
/** Raison pour laquelle un financement retient encore Père (null = aucun) : la flotte auto attend (les bâtiments d'abord). */
export function fundNeedsPere(s: State): string | null {
  for (const o of Object.values(orders)) {
    const p = s.planets.find((x) => x.id === o.planetId);
    if (!p || o.suspendu) continue;
    const cost = optOf(p, o.key)?.cost ?? o.cost;
    const m = manqueOf(p, cost);
    if (sum(m)) return `financement de ${o.name} sur ${o.planetName} en cours (manque ${resFmt(m)}${enVol(o, s) ? ", transport en vol" : ""})`;
  }
  return null;
}

// ---------- Tick (chaque poll, après /fleetbuild, avant /next et l'autobuild) ----------
export async function buildFundTick(s: State, threatened: Set<string>) {
  if (!flags.autobuild) return; // /pause : rien, commandes et réservations conservées
  const pl = loadPlan(s);
  const pere = s.planets.find((p) => p.id === PERE);
  const warn = (o: FundOrder, reason: string, msg: string) => {
    why.set(o.planetId, msg);
    if (warned.get(o.planetId) !== reason) { warned.set(o.planetId, reason); alert(`⏳ Financement ${o.planetName} (${o.name} niv. ${o.next}) — ${msg}\nAucun abandon automatique · /autobuild finance annule ${o.planetName}`); }
  };
  const retire = (o: FundOrder, msg: string) => {
    removeOrder(o.planetId);
    alert(`🗑 Financement ${o.planetName} (${o.name} niv. ${o.next}) retiré : ${msg}. Les ressources déjà livrées restent sur place.`);
    log("FINANCEMENT retiré", o.planetName, o.key, msg);
  };

  // 1. Création : une commande au plus par colonie à autobuild activé, quand elle a un besoin
  if (financementOn(pl) && pere) {
    const ctx = buildCtx(s);
    for (const p of s.planets) {
      // Commande /fleetbuild (ou flotte auto) vers la planète, même encore en route : son coût arriverait dans le stock et fausserait le manque
      if (p.id === PERE || orders[p.id] || fleetBuildOrders().some((o) => o.planetId === p.id)) continue;
      const pp = planetPlan(pl, p.id);
      if (!pp.enabled) continue;
      if (Date.now() - (lastDecision.get(p.id) ?? 0) < DECIDE_EVERY_MS) continue;
      lastDecision.set(p.id, Date.now());
      const { besoin } = nextBuilding(p, pp, ctx);
      if (!besoin || p.buildQueue?.key === besoin.key) continue; // le bâtiment est déjà en cours : rien à financer
      const manque0 = manqueOf(p, besoin.cost);
      orders[p.id] = { planetId: p.id, planetName: p.name, key: besoin.key, name: besoin.name, next: besoin.next, cost: { ...besoin.cost }, manque0, at: Date.now(), voyages: 0, envoye: zero() };
      persist();
      alert(`🏗💰 Financement : Père → ${p.name} pour ${besoin.name} niv. ${besoin.next} · coût ${resFmt(besoin.cost)} · manque ${resFmt(manque0)}\n   ${besoin.raison} · ${p.name} réservée jusqu'au lancement`);
      log("FINANCEMENT", p.name, besoin.key, besoin.next);
    }
  }

  // 2. Suivi des commandes : besoin disparu, arrivée, lancement, voyage suivant
  let envoi = false;
  for (const o of Object.values(orders)) {
    const p = s.planets.find((x) => x.id === o.planetId);
    if (!p) { warn(o, "planete", "planète introuvable dans l'état du jeu"); continue; }
    const pp = planetPlan(pl, p.id);
    const lvl = p.buildings?.[o.key] ?? 0;
    const ob = (pp.objectifs ?? []).find((x) => x.key === o.key);
    if (!pp.enabled) { retire(o, "autobuild désactivé sur la planète"); continue; }
    if (p.buildQueue?.key === o.key) { retire(o, `${o.name} déjà en construction (lancé hors financement)`); continue; }
    if (lvl >= o.next) { retire(o, `${o.name} déjà au niveau ${lvl}`); continue; }
    if (ob && lvl >= ob.max) { retire(o, `objectif ${o.key} ≤ ${ob.max} atteint`); continue; }
    if (o.fleetId || o.arrivesAt) {
      if (enVol(o, s)) { why.set(o.planetId, `transport en vol${o.arrivesAt ? `, arrivée dans ${etaStr(o.arrivesAt - s.now)}` : ""}`); continue; }
      o.fleetId = undefined; o.arrivesAt = undefined; o.lastArrivalAt = Date.now(); persist();
      log("FINANCEMENT", p.name, "livraison arrivée");
    }
    const op = optOf(p, o.key);
    if (!op) { warn(o, "option", `${o.key} absent des options de construction de ${p.name}`); continue; }
    const cost: Res = op.cost;
    const manque = manqueOf(p, cost);
    if (!sum(manque)) {
      // Stock suffisant : lancement dès que la file est libre
      if (p.buildQueue) { why.set(o.planetId, `ressources réunies, file occupée (${p.buildQueue.key}, fin dans ${etaStr(p.buildQueue.finishesAt - s.now)})`); continue; }
      if (o.key === "researchLab" && s.player.researchQueue) { warn(o, "recherche", "ressources réunies, mais le labo est bloqué par la recherche en cours"); continue; }
      if (Date.now() - (lastTry.get(o.planetId) ?? 0) < RETRY_MS) continue;
      lastTry.set(o.planetId, Date.now());
      try {
        await api.build(p.id, o.key);
        removeOrder(o.planetId);
        for (const k of RES_KEYS) p.resources[k] -= cost[k]; // état local recalé jusqu'au prochain poll (l'autobuild du même tick voit la file prise)
        p.buildQueue = { key: o.key, targetLevel: o.next, finishesAt: s.now + (op.durationMs ?? 0) };
        alert(`🏗 ${p.name} : ${o.name} niveau ${o.next} lancé · ${resFmt(cost)} · ${etaStr(op.durationMs ?? 0)} (financé par Père : ${o.voyages} voyage(s), ${resFmt(o.envoye)})`);
        log("FINANCEMENT lancé", p.name, o.key);
      } catch (e: any) {
        const msg = String(e.message).slice(0, 200);
        warn(o, `ko:${msg}`, `lancement refusé par le jeu : ${msg} (nouvel essai dans 1 min)`);
        log("FINANCEMENT KO", p.name, o.key, msg);
      }
      continue;
    }
    // Il manque encore : un voyage de plus, si rien n'est en vol pour cette commande
    if (o.suspendu) { why.set(o.planetId, `voyages suspendus (les livraisons ne comblent pas le manque) — manque ${resFmt(manque)}`); continue; }
    if (Date.now() - (o.lastArrivalAt ?? 0) < STOCK_GRACE_MS) { why.set(o.planetId, "livraison arrivée, crédit en attente"); continue; }
    // Garde-fou : livré deux fois le manque initial sans le combler (stock plafonné par la capacité ? [HYPOTHÈSE à surveiller]) → plus de voyage
    if (o.voyages > 0 && sum(o.envoye) >= 2 * Math.max(1, sum(o.manque0))) {
      o.suspendu = true; persist();
      warn(o, "suspendu", `${fmtNum(sum(o.envoye))} livrés pour un manque initial de ${fmtNum(sum(o.manque0))}, il manque encore ${resFmt(manque)} : voyages suspendus (stock plafonné par la capacité ?)`);
      continue;
    }
    if (!pere) { warn(o, "pere", "Père introuvable"); continue; }
    if (threatened.has(PERE)) { warn(o, "menacePere", "Père menacée : aucun envoi"); continue; }
    if (threatened.has(p.id)) { warn(o, "menace", `${p.name} menacée : aucun envoi`); continue; }
    if (envoi || Date.now() - (lastTry.get(o.planetId) ?? 0) < RETRY_MS) continue;
    const trip = planFundTrip(s, pere, manque);
    if ("why" in trip) { warn(o, trip.code, `${trip.why} — manque ${resFmt(manque)}`); continue; }
    lastTry.set(o.planetId, Date.now());
    const what = `Père → ${p.name} : ${shipsStr(trip.ships)} · ${resFmt(trip.cargo)}`;
    try {
      const plan = prepareFleet(s, { from: PERE, mission: "transport", coords: p.coords, ships: trip.ships, cargo: trip.cargo, label: `🏗💰 Financement ${o.name}` });
      const r = await sendFleet(plan, new Set(s.fleets.map((f) => f.id)));
      o.voyages++; o.fleetId = r.fleetId; o.arrivesAt = r.arrivesAt;
      for (const k of RES_KEYS) o.envoye[k] += trip.cargo[k];
      if (!r.fleetId && !r.arrivesAt) o.arrivesAt = s.now + 60_000; // id et arrivée inconnus : on attend au moins une minute
      persist();
      warned.delete(o.planetId); why.delete(o.planetId);
      alert(`📦 Financement ${o.name} niv. ${o.next} — voyage ${o.voyages} : ${what}\n${fleetResultStr(r)}${sum(trip.cargo) < sum(manque) ? `\nReste à livrer après ce voyage : ${fmtNum(sum(manque) - sum(trip.cargo))}` : ""}`);
      // État local recalé jusqu'au prochain poll (carburant inconnu → non décompté)
      for (const k of RES_KEYS) pere.resources[k] -= trip.cargo[k];
      for (const [k, n] of Object.entries(trip.ships)) pere.ships[k] -= n;
      s.fleetSlots.used++;
      envoi = true; // un seul envoi de flotte par passage (les autres commandes partent aux passages suivants)
    } catch (e: any) {
      const msg = String(e.message).slice(0, 200);
      warn(o, `envoi:${msg}`, `envoi refusé : ${msg} (nouvel essai dans 1 min)`);
      log("FINANCEMENT envoi KO", p.name, msg);
    }
  }
}

// ---------- Résumé Telegram (intégré à /plan) ----------
export function buildFundSummary(s: State): string {
  const pl = loadPlan(s);
  const head = `🏗💰 Financement des colonies par Père : ${financementOn(pl) ? "on" : "off"}${flags.autobuild ? "" : " ⏸ EN PAUSE (/resume)"}`;
  const list = Object.values(orders);
  if (!list.length) return `${head} · aucune commande en cours`;
  return [head + " (/autobuild finance annule <planète> pour retirer)", ...list.map((o) => {
    const p = s.planets.find((x) => x.id === o.planetId);
    const cost: Res = (p && optOf(p, o.key)?.cost) ?? o.cost;
    const m = p ? manqueOf(p, cost) : o.manque0;
    const etat = why.get(o.planetId) ?? (enVol(o, s) ? `transport en vol${o.arrivesAt ? `, arrivée dans ${etaStr(o.arrivesAt - s.now)}` : ""}` : sum(m) ? "prochain voyage au prochain passage" : "lancement au prochain passage");
    return `• ${p?.name ?? o.planetName} : ${o.name} niv. ${o.next} · coût ${resFmt(cost)}\n  manque ${resFmt(m)} · ${o.voyages} voyage(s), livré ${resFmt(o.envoye)}\n  ${etat}`;
  })].join("\n");
}
