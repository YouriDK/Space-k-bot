// Notifications d'événements entre deux polls (horloge serveur) :
//   🏗 bâtiment terminé · 🔬 recherche terminée · 🚀 chantier terminé · 🔍 sondage subi · 💥 impact d'une menace · 📜 rapport inconnu.
// Les ids déjà vus sont persistés dans seen.json pour ne pas re-notifier après un restart pm2.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { State } from "./spacek-client.ts";
import { alert, fmt, log, same } from "./core.ts";
import { threatLabel, type Threat } from "./threats.ts";

const SEEN_FILE = "seen.json";
const KNOWN_REPORT_KINDS = new Set(["pirate", "pirateTresor"]); // formes vues dans le snapshot du 21/09 ; le reste est notifié brut
type Seen = { spy: string[]; reports: string[]; threats: string[] };
let seen: Seen = { spy: [], reports: [], threats: [] };
let seenSets = { spy: new Set<string>(), reports: new Set<string>(), threats: new Set<string>() };
let initialised = false;
let prev: State | null = null;
let dirty = false;
const liveThreats = new Map<string, Threat>(); // menaces vues, pour notifier l'impact

function loadSeen() {
  if (!existsSync(SEEN_FILE)) return;
  try { seen = { ...seen, ...JSON.parse(readFileSync(SEEN_FILE, "utf8")) }; } catch (e: any) { log("seen.json illisible :", e.message); }
  seenSets = { spy: new Set(seen.spy), reports: new Set(seen.reports), threats: new Set(seen.threats) };
}
function saveSeen() {
  if (!dirty) return;
  dirty = false;
  const cap = (a: Set<string>) => [...a].slice(-2000);
  try { writeFileSync(SEEN_FILE, JSON.stringify({ spy: cap(seenSets.spy), reports: cap(seenSets.reports), threats: cap(seenSets.threats) })); }
  catch (e: any) { log("seen.json KO :", e.message); }
}

const buildingName = (s: State, key: string) => s.planets.flatMap((p) => p.buildOptions ?? []).find((b: any) => b.key === key)?.name ?? key;
const researchName = (s: State, key: string) => (s.researchOptions ?? s.planets[0]?.researchOptions ?? []).find((r: any) => r.key === key)?.name ?? key;

/** À appeler à chaque poll, avec les menaces déjà parsées. */
export function notifyTick(s: State, threats: Threat[]) {
  if (!initialised) {
    initialised = true;
    loadSeen();
    const first = seenSets.spy.size === 0 && seenSets.reports.size === 0;
    for (const r of s.spyReports ?? []) seenSets.spy.add(r.id);
    for (const r of s.reports ?? []) seenSets.reports.add(r.id);
    if (first) { dirty = true; saveSeen(); } // 1er démarrage : mémoriser l'existant sans notifier
  } else {
    for (const r of s.spyReports ?? []) {
      if (seenSets.spy.has(r.id)) continue;
      seenSets.spy.add(r.id); dirty = true;
      if (r.role === "defender") alert(`🔍 Sondé par ${r.attackerName ?? "?"} sur ${r.planetName ?? fmt(r.coords)} (${r.probes ?? "?"} sondes)`);
    }
    for (const r of s.reports ?? []) {
      if (seenSets.reports.has(r.id)) continue;
      seenSets.reports.add(r.id); dirty = true;
      // Pas de champ defenderId sur les rapports observés : on ne devine pas, on notifie brut les genres inconnus
      if (!KNOWN_REPORT_KINDS.has(r.kind)) alert(`📜 Nouveau rapport « ${r.kind ?? "?"} » en ${r.coords ? fmt(r.coords) : "?"} — voir le jeu`);
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
    if (seenSets.threats.has(id)) continue;
    seenSets.threats.add(id); dirty = true;
    const p = s.planets.find((x) => same(x.coords, t.target));
    alert(`💥 Impact : ${threatLabel(t).replace(/^\S+ /, "").toLowerCase()}${t.attaquant ? ` de ${t.attaquant}` : ""} sur ${p?.name ?? t.cibleNom ?? fmt(t.target)}`);
  }
  saveSeen();
}
