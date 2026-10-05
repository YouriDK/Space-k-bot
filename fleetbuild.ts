// /fleetbuild : construire des vaisseaux sur le chantier d'une colonie, payés par Père.
// Père envoie le COÛT TOTAL (N × coût unitaire, sans déduire le stock de la colonie : l'auto-construction peut le dépenser
// pendant le vol) en une seule flotte transport (GT d'abord, PT en complément), puis la commande attend l'arrivée et lance
// `api.ships` dès que le stock de la colonie couvre le coût. Cible = Père : pas de transport, construction immédiate.
// Entre l'arrivée et le lancement, la planète est RÉSERVÉE (fleetBuildReserved, via reserve.ts) : autobuild, /next, collect, autodeut,
// autosupply et flotte auto n'y touchent pas.
// Stock insuffisant ou refus du jeu : la commande reste (jamais d'abandon automatique), un essai de POST par minute au plus,
// une alerte par raison. /pause ne suspend pas ces commandes (ordres manuels, comme /next). Persisté dans fleet-build.json.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Planet, Res, State } from "./spacek-client.ts";
import { planetByName } from "./spacek-client.ts";
import {
  PERE, CARGO, DEUT_RESERVE, SHIP_FR, alert, api, etaStr, fmtNum, getState, log, planetOrThrow, prepareFleet, same, sendFleet, shipsStr, type FleetPlan,
} from "./core.ts";

const FILE = "fleet-build.json";
const RETRY_MS = 60_000; // refus du jeu : un POST /ships par minute au plus et par commande
const STOCK_GRACE_MS = 2 * 60_000; // crédit de l'arrivée pas encore visible : pas d'alerte « stock insuffisant » pendant 2 min
const RES_KEYS: (keyof Res)[] = ["metal", "crystal", "deuterium"];
const resFmt = (r: Res) => `M ${fmtNum(r.metal)} · C ${fmtNum(r.crystal)} · D ${fmtNum(r.deuterium)}`;
const k = (n: number) => (n >= 1000 ? `${+(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${n}`);
/** Coût compact pour un bouton : « 20k M 7k C 2k D » (zéros omis). */
export const costShort = (c: Res) => RES_KEYS.filter((x) => c[x] > 0).map((x) => `${k(c[x])} ${x[0].toUpperCase()}`).join(" ") || "gratuit";
export const shipName = (key: string) => SHIP_FR[key] ?? key;

// ---------- Commandes en attente (fleet-build.json) ----------
/** enRoute = transport parti, pas encore arrivé · livree = arrivé, en attente du lancement au chantier (planète réservée). */
export type FleetBuildStatus = "enRoute" | "livree";
export type FleetBuildOrder = {
  id: number; planetId: string; planetName: string; key: string; qty: number; cost: Res; unitMs: number;
  fleetId?: string; arrivesAt?: number; status: FleetBuildStatus; at: number; livreeAt?: number;
};
let seq = 0;
let orders: FleetBuildOrder[] = [];
const lastTry = new Map<number, number>();  // id → dernier POST /ships (refus : au plus un par minute)
const warned = new Map<number, string>();   // id → dernière raison signalée (une alerte par raison)
const why = new Map<number, string>();      // id → raison courante, pour /fleetbuild liste
export function loadFleetBuild() {
  try {
    if (!existsSync(FILE)) { orders = []; seq = 0; return; }
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    orders = Array.isArray(raw?.orders) ? raw.orders : [];
    seq = Math.max(Number(raw?.seq) || 0, ...orders.map((o) => o.id));
  } catch (e: any) { console.error("fleet-build.json illisible :", e.message); }
}
loadFleetBuild();
function persist() {
  try { writeFileSync(`${FILE}.tmp`, JSON.stringify({ seq, orders }, null, 2)); renameSync(`${FILE}.tmp`, FILE); }
  catch (e: any) { log("fleet-build.json KO :", e.message); }
}
export const fleetBuildOrders = (): FleetBuildOrder[] => orders.map((o) => ({ ...o, cost: { ...o.cost } }));
function addOrder(o: Omit<FleetBuildOrder, "id" | "at">): FleetBuildOrder {
  const order = { ...o, id: ++seq, at: Date.now() };
  orders.push(order); persist();
  return order;
}
function removeOrder(id: number) { orders = orders.filter((o) => o.id !== id); lastTry.delete(id); warned.delete(id); why.delete(id); persist(); }
/** /fleetbuild annule <n°> : retire la commande (le transport n'est PAS rappelé). */
export function cancelFleetBuild(id: number): FleetBuildOrder | undefined {
  const o = orders.find((x) => x.id === id);
  if (o) removeOrder(id);
  return o;
}
/** Vrai entre l'arrivée des ressources et le lancement au chantier : autobuild, /next et collect laissent la planète tranquille. */
export const fleetBuildReserved = (planetId: string) => orders.some((o) => o.planetId === planetId && o.status === "livree");

// ---------- Vaisseaux : options du chantier, noms ----------
export type ShipChoice = { key: string; name: string; cost: Res; unitMs: number; locked: boolean };
/** Options du chantier de LA planète (elles diffèrent selon le niveau du chantier) ; coût et durée par unité. */
export const shipChoices = (p: Planet): ShipChoice[] =>
  ((p.shipOptions ?? []) as any[]).map((o) => ({
    key: String(o.key), name: shipName(String(o.key)), unitMs: Number(o.unitMs) || 0, locked: !!o.locked,
    cost: { metal: Number(o.cost?.metal) || 0, crystal: Number(o.cost?.crystal) || 0, deuterium: Number(o.cost?.deuterium) || 0 },
  }));
const norm = (x: string) => x.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[’']/g, " ").replace(/\s+/g, " ").trim()
  .split(" ").map((w) => (w.length > 2 ? w.replace(/[sx]$/, "") : w.replace(/s$/, ""))).join(" "); // pluriels : croiseurs, vaisseaux, gts
const ALIASES: Record<string, string[]> = {
  smallCargo: ["pt", "petit transporteur"], largeCargo: ["gt", "grand transporteur"],
  lightFighter: ["cl", "chasseur leger", "chasseur"], heavyFighter: ["clo", "chasseur lourd"],
  cruiser: ["croiseur"], battleship: ["vb", "vaisseau de bataille"], colonyShip: ["colo", "colonisateur", "vaisseau de colonisation"],
  espionageProbe: ["sonde", "sonde d espionnage"], recycler: ["recycleur", "recy"], pathfinder: ["eclaireur"],
  bomber: ["bombardier"], destroyer: ["destructeur", "destro"], battlecruiser: ["traqueur"], deathStar: ["edlm", "etoile de la mort", "rip"],
  solarSatellite: ["satellite", "sat", "satellite solaire"],
};
const SHIP_TABLE = new Map<string, string>(Object.entries(SHIP_FR).flatMap(([key, fr]) => [[norm(fr), key], ...(ALIASES[key] ?? []).map((a) => [norm(a), key] as [string, string])]));
/** Clé API (cruiser, casse libre, y compris les clés du chantier hors SHIP_FR) ou nom français (croiseur(s), gt, vb, éclaireurs…). */
export function resolveShip(q: string, keys: string[] = []): string | undefined {
  const raw = q.trim().toLowerCase();
  const byKey = [...keys, ...Object.keys(SHIP_FR), ...Object.keys(CARGO)].find((x) => x.toLowerCase() === raw);
  return byKey ?? SHIP_TABLE.get(norm(q));
}

/** /fleetbuild <planète…> [<vaisseau…> [<qté>|max]] : le vaisseau est cherché en fin de ligne (1 à 3 mots), le reste est la planète. */
export function parseFleetBuildArgs(s: State, args: string[]): { p: Planet; key?: string; qty?: number | "max" } {
  const last = (args[args.length - 1] ?? "").toLowerCase();
  const hasQty = args.length >= 3 && /^(\d+|max)$/.test(last);
  const rest = hasQty ? args.slice(0, -1) : args;
  for (let n = Math.min(3, rest.length - 1); n >= 1; n--) {
    const p = planetByName(s, rest.slice(0, -n).join(" "));
    const key = p && resolveShip(rest.slice(-n).join(" "), shipChoices(p).map((c) => c.key));
    if (p && key) return { p, key, ...(hasQty ? { qty: last === "max" ? "max" as const : Number(last) } : {}) };
  }
  if (hasQty) throw new Error(`Vaisseau inconnu : « ${rest.slice(1).join(" ")} » (clé API ou nom : croiseur, gt, pt, vb, éclaireur, traqueur, sonde, recycleur…)`);
  return { p: planetOrThrow(s, args.join(" ")) };
}

// ---------- Calcul pur ----------
const mul = (c: Res, n: number): Res => ({ metal: Math.ceil(c.metal * n), crystal: Math.ceil(c.crystal * n), deuterium: Math.ceil(c.deuterium * n) });
/** Ce que Père peut donner : tout son stock pour un build sur place, DEUT_RESERVE gardée pour le carburant s'il y a un vol. */
const pereDispo = (pere: Planet, direct: boolean): Res => ({
  metal: Math.floor(pere.resources.metal), crystal: Math.floor(pere.resources.crystal),
  deuterium: Math.max(0, Math.floor(pere.resources.deuterium) - (direct ? 0 : DEUT_RESERVE)),
});
const quaiCap = (pere: Planet) => (pere.ships.largeCargo ?? 0) * CARGO.largeCargo + (pere.ships.smallCargo ?? 0) * CARGO.smallCargo;
/** Plus grande quantité que Père peut financer ET (hors Père) transporter. */
export function fleetBuildMax(s: State, p: Planet, key: string): { max: number; byRes: number; byCargo: number } {
  const pere = planetOrThrow(s, PERE);
  const c = shipChoices(p).find((x) => x.key === key);
  if (!c) return { max: 0, byRes: 0, byCargo: 0 };
  const direct = p.id === pere.id, dispo = pereDispo(pere, direct);
  const unit = c.cost.metal + c.cost.crystal + c.cost.deuterium;
  const byRes = Math.min(...RES_KEYS.filter((x) => c.cost[x] > 0).map((x) => Math.floor(dispo[x] / c.cost[x])));
  const byCargo = direct ? Infinity : unit > 0 ? Math.floor(quaiCap(pere) / unit) : Infinity;
  const max = Math.min(byRes, byCargo);
  return { max: Number.isFinite(max) ? max : 0, byRes: Number.isFinite(byRes) ? byRes : 0, byCargo };
}

export type FleetBuildPlan = {
  p: Planet; key: string; name: string; qty: number; cost: Res; unitMs: number; durationMs: number;
  direct: boolean; ships: Record<string, number>; fleet?: FleetPlan; left: Res; summary: string;
};
/** Vérifie tout AVANT envoi (refus chiffrés) et prépare le transport. Aucun POST, aucune mutation de s. */
export function planFleetBuild(s: State, planet: string | Planet, key: string, qty: number): FleetBuildPlan {
  const pere = planetOrThrow(s, PERE);
  const p = typeof planet === "string" ? planetOrThrow(s, planet) : planet;
  const lvl = p.buildings?.shipyard ?? 0;
  if (lvl < 1) throw new Error(`Pas de chantier spatial sur ${p.name}`);
  const c = shipChoices(p).find((x) => x.key === key);
  if (!c) throw new Error(`${shipName(key)} : inconnu du chantier de ${p.name} (${shipChoices(p).filter((x) => !x.locked).map((x) => x.key).join(", ") || "aucune option"})`);
  if (c.locked) throw new Error(`🔒 ${c.name} verrouillé sur ${p.name} (chantier niv. ${lvl})`);
  if (!Number.isInteger(qty) || qty < 1) throw new Error(`Quantité invalide : ${qty}`);
  const direct = p.id === pere.id;
  const cost = mul(c.cost, qty), dispo = pereDispo(pere, direct);
  const { max, byRes, byCargo } = fleetBuildMax(s, p, key);
  const manque = RES_KEYS.filter((x) => cost[x] > dispo[x]);
  if (manque.length) throw new Error(`Père n'a pas les ressources pour ${qty} ${c.name} : il faut ${resFmt(cost)}, Père a ${resFmt(dispo)}${direct ? "" : ` (deut hors réserve de ${fmtNum(DEUT_RESERVE)})`}` +
    ` — max finançable : ${byRes}`);
  const left: Res = { metal: pere.resources.metal - cost.metal, crystal: pere.resources.crystal - cost.crystal, deuterium: pere.resources.deuterium - cost.deuterium };
  const durationMs = qty * c.unitMs;
  const head = [
    `🚀 Construction de flotte sur ${p.name} (chantier niv. ${lvl}${p.shipQueue ? ` · file : ${p.shipQueue.remaining} ${shipName(p.shipQueue.key)} en cours` : ""})`,
    `${qty} × ${c.name} · coût ${resFmt(cost)}`,
    `Durée de construction estimée : ${etaStr(durationMs)} (${qty} × ${etaStr(c.unitMs)})`,
  ];
  if (direct) {
    const summary = [...head, `Sur place : pas de transport, lancement immédiat au chantier`, `Sur Père après lancement : ${resFmt(left)}`].join("\n");
    return { p, key, name: c.name, qty, cost, unitMs: c.unitMs, durationMs, direct, ships: {}, left, summary };
  }
  // Transporteurs à quai sur Père : GT d'abord, PT en complément, UNE flotte, cargaison = coût exact (tout ou rien)
  const total = cost.metal + cost.crystal + cost.deuterium;
  const gt = pere.ships.largeCargo ?? 0, pt = pere.ships.smallCargo ?? 0;
  const nGt = Math.min(gt, Math.ceil(total / CARGO.largeCargo));
  const nPt = Math.ceil(Math.max(0, total - nGt * CARGO.largeCargo) / CARGO.smallCargo);
  if (nPt > pt) {
    const trou = total - quaiCap(pere);
    throw new Error(`Pas assez de transporteurs sur Père pour ${fmtNum(total)} de cargaison : soute à quai ${fmtNum(quaiCap(pere))} (${gt} GT + ${pt} PT)` +
      ` — il en faut ${Math.ceil(trou / CARGO.largeCargo)} GT (ou ${Math.ceil(trou / CARGO.smallCargo)} PT) de plus, soit ${Math.ceil(total / CARGO.largeCargo)} GT en tout — max transportable : ${byCargo}`);
  }
  if (s.fleetSlots.used >= s.fleetSlots.total) throw new Error(`Aucun slot de flotte libre (${s.fleetSlots.used}/${s.fleetSlots.total})`);
  const ships: Record<string, number> = {}; if (nGt) ships.largeCargo = nGt; if (nPt) ships.smallCargo = nPt;
  const fleet = prepareFleet(s, { from: PERE, mission: "transport", coords: p.coords, ships, cargo: cost, label: `🚀 Fleetbuild ${qty} ${c.name}` });
  const summary = [...head,
    `Transport Père → ${p.name} : ${shipsStr(ships)} · cargaison = coût (soute ${fmtNum(nGt * CARGO.largeCargo + nPt * CARGO.smallCargo)}) · slots ${s.fleetSlots.used}/${s.fleetSlots.total}`,
    `Sur Père après envoi : ${resFmt(left)} (hors carburant)`,
    `À l'arrivée : lancement automatique au chantier ; ${p.name} réservée (ni autobuild, ni /next, ni collecte) jusqu'au lancement`,
    `(max possible avec les stocks et transporteurs actuels de Père : ${max})`,
  ].join("\n");
  return { p, key, name: c.name, qty, cost, unitMs: c.unitMs, durationMs, direct, ships, fleet, left, summary };
}

// ---------- Exécution (après ✅) ----------
const clock = (t: number) => new Date(t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
/** Lance le plan : build direct sur Père, sinon transport puis commande persistée. Renvoie le texte de réponse. */
export async function startFleetBuild(s: State, plan: FleetBuildPlan): Promise<string> {
  const { p, key, name, qty, cost, unitMs, durationMs } = plan;
  if (plan.direct || !plan.fleet) {
    await api.ships(p.id, key, qty); // réponse = état complet : jamais affichée
    log("FLEETBUILD direct", p.name, key, qty);
    return `🚀 ${p.name} : ${qty} ${name} en construction, durée estimée ${etaStr(durationMs)}`;
  }
  const r = await sendFleet(plan.fleet, new Set(s.fleets.map((f) => f.id)));
  const o = addOrder({ planetId: p.id, planetName: p.name, key, qty, cost, unitMs, fleetId: r.fleetId, arrivesAt: r.arrivesAt, status: "enRoute" });
  log("FLEETBUILD", `n°${o.id}`, p.name, key, qty, "flotte", r.fleetId ?? "?");
  const now = (r.state as any)?.now ?? Date.now();
  return `📦 Transport parti : ${shipsStr(plan.ships)} · flotte ${r.fleetId ?? "(id inconnu)"}` +
    `${r.arrivesAt ? ` · arrivée dans ${etaStr(r.arrivesAt - now)} (vers ${clock(r.arrivesAt)})` : " · heure d'arrivée inconnue"}\n` +
    `Commande n°${o.id} enregistrée : ${qty} ${name} lancés sur ${p.name} dès l'arrivée (/fleetbuild liste)`;
}
/** Exécution d'une confirmation : état frais, mêmes vérifications, puis lancement. */
export async function runFleetBuild(planetId: string, key: string, qty: number): Promise<string> {
  const s = await getState();
  return startFleetBuild(s, planFleetBuild(s, planetId, key, qty));
}

// ---------- Tick (chaque poll, avant /next et autobuild) ----------
/** Arrivée : arrivesAt passé (horloge serveur) ; sinon flotte connue plus en phase aller ; sinon plus aucun transport aller de Père vers la planète. */
function arrived(o: FleetBuildOrder, s: State, p: Planet): boolean {
  if (o.arrivesAt) return s.now >= o.arrivesAt;
  if (o.fleetId) { const f = s.fleets.find((x) => x.id === o.fleetId); return !f || f.phase !== "outbound"; }
  return !s.fleets.some((f) => f.mission === "transport" && f.phase === "outbound" && f.origin?.planetId === PERE && same(f.target?.coords, p.coords));
}
export async function fleetBuildTick(s: State) {
  const warn = (o: FleetBuildOrder, reason: string, msg: string) => {
    why.set(o.id, msg);
    if (warned.get(o.id) !== reason) { warned.set(o.id, reason); alert(`⏳ ${o.planetName} : ${o.qty} ${shipName(o.key)} (n°${o.id}) pas encore lancés — ${msg}\nAucun abandon automatique · /fleetbuild annule ${o.id}`); }
  };
  for (const o of [...orders]) {
    const p = s.planets.find((x) => x.id === o.planetId);
    if (!p) { warn(o, "planete", "planète introuvable dans l'état du jeu"); continue; }
    if (o.status === "enRoute") {
      if (!arrived(o, s, p)) continue;
      o.status = "livree"; o.livreeAt = Date.now(); persist();
      log("FLEETBUILD", `n°${o.id}`, "ressources arrivées sur", p.name);
    }
    const trou = RES_KEYS.filter((x) => Math.floor(p.resources[x]) < o.cost[x]);
    if (trou.length) {
      // Crédit pas encore visible, ressources dépensées, flotte rappelée… : on attend, sans POST (alerte après le délai de grâce)
      const msg = `stock insuffisant sur ${p.name} : manque ${trou.map((x) => `${x[0].toUpperCase()} ${fmtNum(o.cost[x] - Math.floor(p.resources[x]))}`).join(" · ")} (vérifié à chaque passage)`;
      if (Date.now() - (o.livreeAt ?? 0) < STOCK_GRACE_MS) why.set(o.id, msg); else warn(o, "stock", msg);
      continue;
    }
    if (Date.now() - (lastTry.get(o.id) ?? 0) < RETRY_MS) continue;
    lastTry.set(o.id, Date.now());
    try {
      await api.ships(p.id, o.key, o.qty);
      removeOrder(o.id);
      for (const x of RES_KEYS) p.resources[x] -= o.cost[x]; // état local recalé jusqu'au prochain poll (commande suivante, autobuild du même tick)
      alert(`🚀 ${p.name} : ${o.qty} ${shipName(o.key)} en construction, durée estimée ${etaStr(o.qty * o.unitMs)} (commande n°${o.id})`);
    } catch (e: any) {
      const msg = String(e.message).slice(0, 200);
      warn(o, `ko:${msg}`, `refusé par le jeu : ${msg} (nouvel essai dans 1 min)`);
      log("FLEETBUILD KO", p.name, o.key, o.qty, msg);
    }
  }
}

// ---------- Résumé Telegram ----------
export function fleetBuildSummary(s: State): string {
  if (!orders.length) return "🚀 Aucune construction de flotte en cours (/fleetbuild pour en lancer une).";
  return ["🚀 Constructions de flotte (/fleetbuild annule <n°> pour retirer)", ...orders.map((o) => {
    const p = s.planets.find((x) => x.id === o.planetId);
    const etat = o.status === "livree"
      ? `⏳ ressources arrivées, en attente du chantier — ${why.get(o.id) ?? "lancement au prochain passage"}`
      : o.arrivesAt && o.arrivesAt > s.now ? `📦 ressources en route — arrivée dans ${etaStr(o.arrivesAt - s.now)} (vers ${clock(o.arrivesAt)})`
        : `📦 ressources en route — ${o.arrivesAt ? "arrivée imminente" : "heure d'arrivée inconnue"}${o.fleetId ? ` (flotte ${o.fleetId})` : ""}`;
    return `n°${o.id} · ${p?.name ?? o.planetName} : ${o.qty} × ${shipName(o.key)} · ${resFmt(o.cost)}\n   ${etat}`;
  })].join("\n");
}
