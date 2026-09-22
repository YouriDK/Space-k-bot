// Notifications d'événements entre deux polls (horloge serveur) :
//   🏗 bâtiment · 🔬 recherche · 🚀 chantier terminés · 🔍 sondage subi · 💥 raid subi · ☠ raid pirate
//   🏆 trésor pirate · 🛬 retour de flotte · 💥 impact d'une menace.
// Formes RÉELLES [TESTÉ 22/09] :
//   alertesVives[] = { id, type:"espionnage", at, donnees: { attaquant, corps, coords, envoyees, reperees } } (événement passé)
//   reports[] sans `kind` = combat subi : { attackerName, defenderId, planetName, outcome, plunder, defenderLosses, attackerSurvivors, role }
//   reports[] kind "pirate" (butin, attackerLosses, repaireDetruit, tier, rallies) et "pirateTresor" (rang, degats, gain)
//   arrivalReports[] = { id, kind:"arrivee", mission:"retour", corps, ships, cargo, ownerId }
// Les ids déjà vus sont persistés dans seen.json pour ne pas re-notifier après un restart pm2.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { State } from "./spacek-client.ts";
import { SHIP_FR, alert, fmt, fmtNum, log, same } from "./core.ts";
import { threatLabel, type Threat } from "./threats.ts";

const SEEN_FILE = "seen.json";
type Bucket = "spy" | "reports" | "threats" | "alerts" | "arrivals";
const BUCKETS: Bucket[] = ["spy", "reports", "threats", "alerts", "arrivals"];
const seenSets: Record<Bucket, Set<string>> = { spy: new Set(), reports: new Set(), threats: new Set(), alerts: new Set(), arrivals: new Set() };
let initialised = false;
let prev: State | null = null;
let dirty = false;
const liveThreats = new Map<string, Threat>(); // menaces vues, pour notifier l'impact

function loadSeen() {
  if (!existsSync(SEEN_FILE)) return;
  try {
    const j = JSON.parse(readFileSync(SEEN_FILE, "utf8"));
    for (const b of BUCKETS) for (const id of j[b] ?? []) seenSets[b].add(id);
  } catch (e: any) { log("seen.json illisible :", e.message); }
}
function saveSeen() {
  if (!dirty) return;
  dirty = false;
  try { writeFileSync(SEEN_FILE, JSON.stringify(Object.fromEntries(BUCKETS.map((b) => [b, [...seenSets[b]].slice(-2000)])))); }
  catch (e: any) { log("seen.json KO :", e.message); }
}
/** true la première fois qu'on voit cet id. */
function isNew(b: Bucket, id: string) {
  if (!id || seenSets[b].has(id)) return false;
  seenSets[b].add(id); dirty = true; return true;
}

const buildingName = (s: State, key: string) => s.planets.flatMap((p) => p.buildOptions ?? []).find((b: any) => b.key === key)?.name ?? key;
const researchName = (s: State, key: string) => (s.researchOptions ?? s.planets[0]?.researchOptions ?? []).find((r: any) => r.key === key)?.name ?? key;
const resLine = (x: any) => x ? `${fmtNum(x.metal ?? 0)} M · ${fmtNum(x.crystal ?? 0)} C · ${fmtNum(x.deuterium ?? 0)} D` : "—";
const shipLine = (x: any) => {
  const e = Object.entries(x ?? {}).filter(([, n]) => Number(n) > 0);
  return e.length ? e.map(([k, n]) => `${n} ${SHIP_FR[k] ?? k}`).join(", ") : "aucune";
};

/** Alerte vive (événement déjà passé) → une ligne lisible ; type inconnu = résumé compact, jamais un JSON géant. */
function alerteStr(a: any): string {
  const d = a?.donnees ?? {};
  if (a?.type === "espionnage")
    return `🔍 ${d.attaquant ?? "?"} a sondé ${d.corps ?? "?"}${d.coords ? ` (${d.coords})` : ""} : ${d.envoyees ?? "?"} sonde(s) envoyée(s), ${d.reperees ?? 0} repérée(s)`;
  const compact = Object.entries(d).map(([k, v]) => `${k} ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ");
  return `⚠️ Alerte « ${a?.type ?? "?"} » : ${compact}`.slice(0, 300);
}

/** Rapport → une ligne lisible, ou null si ce rapport ne nous concerne pas. */
function reportStr(r: any, s: State): string | null {
  const where = r.planetName ?? (r.coords ? fmt(r.coords) : "?");
  if (!r.kind) { // combat subi
    if (r.role !== "defender" && r.defenderId !== s.player?.id) return null; // nos propres attaques : déjà notifiées ailleurs
    const perdu = shipLine(r.defenderLosses) === "aucune" && shipLine(r.rebuiltDefences) === "aucune" ? "aucune" : shipLine(r.defenderLosses);
    return `💥 Raid de ${r.attackerName ?? "?"} sur ${where} : pillé ${resLine(r.plunder)}`
      + ` · pertes défense : ${perdu} · survivants attaquant : ${shipLine(r.attackerSurvivors)}`;
  }
  if (r.kind === "pirate")
    return `☠ Raid pirate ${r.tier ?? ""} en ${r.coords ? fmt(r.coords) : "?"} : butin ${resLine(r.butin)}`
      + ` · pertes ${shipLine(r.attackerLosses)} · repaire ${r.repaireDetruit ? "détruit ✅" : "toujours debout"}`
      + (Array.isArray(r.rallies) && r.rallies.length ? ` · avec ${r.rallies.join(", ")}` : "");
  if (r.kind === "pirateTresor")
    return `🏆 Trésor pirate : rang ${r.rang ?? "?"} · gain ${resLine(r.gain)}${r.degats ? ` · dégâts ${fmtNum(r.degats)}` : ""}`;
  return `📜 Rapport « ${r.kind} » en ${where}`;
}

/** À appeler à chaque poll, avec les menaces déjà parsées. */
export function notifyTick(s: State, threats: Threat[]) {
  if (!initialised) {
    initialised = true;
    loadSeen();
    const vierge = BUCKETS.every((b) => seenSets[b].size === 0);
    for (const r of s.spyReports ?? []) seenSets.spy.add(r.id);
    for (const r of s.reports ?? []) seenSets.reports.add(r.id);
    for (const a of s.alertesVives ?? []) seenSets.alerts.add(a.id);
    for (const a of s.arrivalReports ?? []) seenSets.arrivals.add(a.id);
    if (vierge) { dirty = true; saveSeen(); } // 1er démarrage : mémoriser l'existant sans notifier
  } else {
    for (const r of s.spyReports ?? []) {
      if (!isNew("spy", r.id)) continue;
      if (r.role === "defender") alert(`🔍 Sondé par ${r.attackerName ?? "?"} sur ${r.planetName ?? fmt(r.coords)} (${r.probes ?? "?"} sondes)`);
    }
    for (const a of s.alertesVives ?? []) if (isNew("alerts", a.id)) alert(alerteStr(a));
    for (const r of s.reports ?? []) {
      if (!isNew("reports", r.id)) continue;
      const msg = reportStr(r, s);
      if (msg) alert(msg);
    }
    for (const a of s.arrivalReports ?? []) {
      if (!isNew("arrivals", a.id)) continue;
      if (a.mission !== "retour" || (a.ownerId && a.ownerId !== s.player?.id)) { log("arrivalReport ignoré", a.kind, a.mission); continue; }
      const cargo = a.cargo && (a.cargo.metal || a.cargo.crystal || a.cargo.deuterium) ? ` · ${resLine(a.cargo)}` : "";
      alert(`🛬 Retour sur ${a.corps ?? fmt(a.coords)} : ${shipLine(a.ships)}${cargo}`);
    }
  }

  if (prev) {
    for (const p of s.planets) {
      const q = prev.planets.find((x) => x.id === p.id);
      if (!q) continue;
      // Bâtiment : la file passe à null (ou change de clé) et le niveau visé est atteint
      const bq = q.buildQueue;
      if (bq && (!p.buildQueue || p.buildQueue.key !== bq.key || p.buildQueue.targetLevel !== bq.targetLevel)) {
        const lvl = p.buildings?.[bq.key] ?? 0;
        if (lvl >= bq.targetLevel) alert(`🏗 ${p.name} : ${buildingName(s, bq.key)} niveau ${bq.targetLevel} terminé`);
        else log("buildQueue disparue sans niveau atteint (annulée ?)", p.name, bq.key);
      }
      // Chantier : la file se termine (null) ou passe au lot suivant
      const sq = q.shipQueue;
      if (sq && (!p.shipQueue || p.shipQueue.key !== sq.key || p.shipQueue.startedAt !== sq.startedAt)) {
        alert(`🚀 ${p.name} : ${sq.total} ${sq.name ?? sq.key} terminés`);
      }
    }
    const rq = prev.player.researchQueue;
    const cur = s.player.researchQueue;
    if (rq && (!cur || cur.key !== rq.key || cur.targetLevel !== rq.targetLevel)) {
      const lvl = s.player.research?.[rq.key] ?? 0;
      const where = s.planets.find((p) => p.id === rq.planetId)?.name;
      if (lvl >= rq.targetLevel) alert(`🔬 ${researchName(s, rq.key)} niveau ${rq.targetLevel} terminé${where ? ` (${where})` : ""}`);
      else log("researchQueue disparue sans niveau atteint (annulée ?)", rq.key);
    }
  }
  prev = s;

  // Impact des menaces : quand arrivesAt est passé (ou que la menace disparaît après son heure)
  for (const t of threats) liveThreats.set(t.id, t);
  for (const [id, t] of liveThreats) {
    const still = threats.some((x) => x.id === id);
    if (s.now < t.arrivesAt && still) continue;
    liveThreats.delete(id);
    if (s.now < t.arrivesAt) continue; // disparue avant l'heure : rappelée par l'attaquant
    if (!isNew("threats", id)) continue;
    const p = s.planets.find((x) => same(x.coords, t.target));
    alert(`💥 Impact : ${threatLabel(t).replace(/^\S+ /, "").toLowerCase()}${t.attaquant ? ` de ${t.attaquant}` : ""} sur ${p?.name ?? t.cibleNom ?? fmt(t.target)}`);
  }
  saveSeen();
}
