// Récupération automatique : champs de débris (recycleurs) et cargaisons abandonnées (transporteurs + escorte).
// Formes [TESTÉ 22/09] : /galaxy/carte → systemes[].debris / .cargaison (booléens) ; /galaxy?system=N →
//   slots[].debris = { metal, crystal } · slots[].recup = { id, total, expireA } · sys.recup = { restantes, plafond, remiseA } (quota journalier).
// Missions [BUNDLE] : débris = `recycle` avec coords.body = "debris" ; cargaison = `recuperation` (« n'importe quelle soute suffit »).
import type { Coords, Planet, State } from "./spacek-client.ts";
import { CARGO, alert, api, fleetResultStr, flags, fmt, fmtNum, fmtDur, log, num, same, sendFleetFuelSafe, sleep } from "./core.ts";

const CHECK_MS = num("SALVAGE_CHECK_MS", 10 * 60_000); // relevé galaxie
const DEBRIS_MIN = num("DEBRIS_MIN", 40_000);          // métal + cristal minimum pour déranger les recycleurs
const RECYCLERS = num("RECYCLERS_PER_FIELD", 2);
const RECUP_SHIPS: Record<string, number> = { smallCargo: num("RECUP_SMALL_CARGO", 15), heavyFighter: num("RECUP_HEAVY_FIGHTER", 10) };

let lastCheck = 0;
const sent = new Map<string, number>(); // "recycle 12:7" → horodatage, pour ne pas renvoyer sur la même cible

/** Durée de vol estimée (ms) — formule [CALCULÉ] exacte sur 2 flottes, distance [HYPOTHÈSE]. */
function flightMs(s: State, from: Planet, to: Coords, ships: Record<string, number>): number | null {
  const v = s.player.vitesses ?? {};
  const speeds = Object.keys(ships).map((k) => v[k]).filter((x) => typeof x === "number" && x > 0) as number[];
  if (!speeds.length) return null;
  const distance = 2700 + 95 * Math.abs(from.coords.system - to.system);
  return Math.ceil((4_800_000 * distance) / Math.min(...speeds));
}

/** Planète disposant de tous les vaisseaux demandés, la plus proche de la cible. */
function sourceFor(s: State, ships: Record<string, number>, target: Coords): Planet | undefined {
  return s.planets
    .filter((p) => Object.entries(ships).every(([k, n]) => (p.ships[k] ?? 0) >= n))
    .sort((a, b) => Math.abs(a.coords.system - target.system) - Math.abs(b.coords.system - target.system))[0];
}

const enRoute = (s: State, mission: string, c: Coords) =>
  s.fleets.some((f) => f.mission === mission && f.target?.coords && same(f.target.coords, c));

async function go(s: State, kind: "recycle" | "recuperation", target: Coords, ships: Record<string, number>, what: string, body?: "debris") {
  const k = `${kind} ${fmt(target)}`;
  if (Date.now() - (sent.get(k) ?? 0) < 60 * 60_000) return;      // déjà traité dans l'heure
  if (enRoute(s, kind, target)) return;                            // flotte déjà en route
  const src = sourceFor(s, ships, target);
  if (!src) { log(`${kind} ${fmt(target)} : flotte indisponible (${Object.entries(ships).map(([a, b]) => `${b} ${a}`).join(", ")})`); return; }
  if (s.fleetSlots.used >= s.fleetSlots.total) { log(`${kind} : aucun slot libre`); return; }
  sent.set(k, Date.now());
  const { res, note } = await sendFleetFuelSafe(
    { planetId: src.id, mission: kind, coords: { ...target, ...(body ? { body } : {}) } as Coords, ships, cargo: { metal: 0, crystal: 0, deuterium: 0 }, speedPercent: 100 },
    src.resources, 0, new Set(s.fleets.map((f) => f.id)));
  s.fleetSlots.used++;
  alert(`${kind === "recycle" ? "♻️ RECYCLAGE" : "📦 RÉCUPÉRATION"} ${what} — depuis ${src.name}${note ? `\n${note}` : ""}\n${fleetResultStr(res)}`);
}

/** À appeler à chaque poll ; n'interroge la galaxie que toutes les SALVAGE_CHECK_MS. */
export async function salvageTick(s: State) {
  if (!flags.recycle && !flags.recup) return;
  if (Date.now() - lastCheck < CHECK_MS) return;
  lastCheck = Date.now();
  const carte = await api.galaxy();
  const systemes = carte.systemes.filter((x: any) => (flags.recycle && x.debris) || (flags.recup && x.cargaison));
  for (const sy of systemes) {
    const sys = await api.galaxySystem(sy.system);
    await sleep(150);
    for (const sl of sys.slots) {
      const target = { system: sys.system, position: sl.position };
      if (flags.recycle && sl.debris) {
        const total = (sl.debris.metal ?? 0) + (sl.debris.crystal ?? 0);
        if (total < DEBRIS_MIN) { log(`Débris ${fmt(target)} : ${fmtNum(total)} < ${fmtNum(DEBRIS_MIN)}`); continue; }
        await go(s, "recycle", target, { recycler: RECYCLERS }, `${fmt(target)} · ${fmtNum(total)} (M ${fmtNum(sl.debris.metal)} · C ${fmtNum(sl.debris.crystal)})`, "debris")
          .catch((e) => alert(`❌ Recyclage ${fmt(target)} : ${e.message}`));
      }
      if (flags.recup && (sl as any).recup) {
        const r = (sl as any).recup as { id: string; total: number; expireA: number };
        const quota = (sys as any).recup as { restantes: number; plafond: number; remiseA: number } | undefined;
        if (quota && quota.restantes <= 0) { log(`Cargaison ${fmt(target)} : quota épuisé (${quota.plafond}/jour, remise à zéro dans ${fmtDur(quota.remiseA - s.now)})`); continue; }
        const src = sourceFor(s, RECUP_SHIPS, target);
        const eta = src ? flightMs(s, src, target, RECUP_SHIPS) : null;
        if (eta && r.expireA && s.now + eta * 1.1 > r.expireA) { log(`Cargaison ${fmt(target)} : s'éteint dans ${fmtDur(r.expireA - s.now)}, vol ~${fmtDur(eta)} → trop tard`); continue; }
        await go(s, "recuperation", target, RECUP_SHIPS, `${fmt(target)} · ≈ ${fmtNum(r.total)} · s'éteint dans ${fmtDur(r.expireA - s.now)}`)
          .catch((e) => alert(`❌ Récupération ${fmt(target)} : ${e.message}`));
      }
    }
  }
}

/** /salvage : ce que le bot voit actuellement (sans rien envoyer). */
export async function salvageSummary(s: State): Promise<string> {
  const carte = await api.galaxy();
  const lines: string[] = [];
  for (const sy of carte.systemes.filter((x: any) => x.debris || x.cargaison)) {
    const sys = await api.galaxySystem(sy.system);
    await sleep(150);
    for (const sl of sys.slots) {
      const t = { system: sys.system, position: sl.position };
      if (sl.debris) {
        const total = (sl.debris.metal ?? 0) + (sl.debris.crystal ?? 0);
        lines.push(`♻️ ${fmt(t)} — ${fmtNum(total)} (M ${fmtNum(sl.debris.metal)} · C ${fmtNum(sl.debris.crystal)})${total < DEBRIS_MIN ? " · sous le seuil" : ""}`);
      }
      if ((sl as any).recup) {
        const r = (sl as any).recup;
        lines.push(`📦 ${fmt(t)} — cargaison ≈ ${fmtNum(r.total)} · s'éteint dans ${fmtDur(r.expireA - s.now)}`);
      }
    }
  }
  const q = await api.galaxySystem(s.planets[0].coords.system).then((x: any) => x.recup).catch(() => null);
  return [
    `Recyclage ${flags.recycle ? "ON" : "off"} (seuil ${fmtNum(DEBRIS_MIN)}, ${RECYCLERS} recycleurs) · Récupération ${flags.recup ? "ON" : "off"} (${Object.entries(RECUP_SHIPS).map(([k, n]) => `${n} ${k}`).join(" + ")})`,
    q ? `Quota cargaisons : ${q.restantes}/${q.plafond} aujourd'hui` : "",
    ...(lines.length ? lines : ["Rien à récupérer dans la galaxie."]),
  ].filter(Boolean).join("\n");
}
