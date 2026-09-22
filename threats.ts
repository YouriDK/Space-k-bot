// Menaces en approche : `menaces[]` et `incoming[]` de /state.
// Format RÉEL observé en live le 22/09/2026 [TESTÉ] :
//   menaces[] = { fleetId, mission, arrivesAt, attaquant, origine: { galaxy, system, position },
//                 cible: { coords: { galaxy, system, position }, body, nom }, palier, total,
//                 types: [{ key, count }] }
//   incoming[] : même famille (vide pendant l'attaque observée), indexé par fleetId.
// `alertesVives[]` n'est PAS une menace (événement déjà passé, sans arrivesAt) → traité dans notify.ts.
// Le brut part dans incoming-samples.jsonl ; Telegram ne reçoit que du texte lisible
// (le brut uniquement si un élément n'est pas reconnu, une seule fois par élément).
import type { Coords, State } from "./spacek-client.ts";
import { SHIP_FR, alert, appendJsonl, etaStr, fmt, same, xy } from "./core.ts";

export type Threat = {
  id: string; mission?: string; arrivesAt: number; target: Coords;
  attaquant?: string; cibleNom?: string; cibleBody?: string; origine?: Coords;
  palier?: string; total?: number; types?: { key: string; count: number }[]; raw: any;
};

let lastSample = "";
const unparsed = new Set<string>(); // éléments non reconnus déjà signalés

export function parseThreats(s: State): Threat[] {
  const raw = [...(s.incoming ?? []), ...(s.menaces ?? [])];
  if (raw.length || (s.alertesVives ?? []).length) {
    const sample = JSON.stringify({ incoming: s.incoming, menaces: s.menaces, alertesVives: s.alertesVives });
    if (sample !== lastSample) { lastSample = sample; appendJsonl("incoming-samples.jsonl", { now: s.now, ...JSON.parse(sample) }); }
  }
  const out = new Map<string, Threat>();
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const id = String(f.fleetId ?? f.id ?? "");
    const arrivesAt = Number(f.arrivesAt ?? f.impactAt ?? NaN);
    const target = f.cible?.coords ?? f.target?.coords ?? f.coords;
    if (!id || !Number.isFinite(arrivesAt) || !target?.system) {
      const k = id || JSON.stringify(f).slice(0, 100);
      if (!unparsed.has(k)) { unparsed.add(k); alert(`⚠️ Menace au format inattendu (à corriger) :\n${JSON.stringify(f).slice(0, 600)}`); }
      continue;
    }
    out.set(id, {
      id, mission: f.mission, arrivesAt, target: xy(target), attaquant: f.attaquant,
      cibleNom: f.cible?.nom, cibleBody: f.cible?.body, origine: f.origine ? xy(f.origine) : undefined,
      palier: f.palier, total: f.total, types: Array.isArray(f.types) ? f.types : undefined, raw: f,
    });
  }
  return [...out.values()];
}

/** Même logique que l'UI du jeu : tout ce qui n'est ni sondage ni destruction de lune est une « Attaque ». */
export const isAttack = (t: Threat) => t.mission !== "espionage" && t.mission !== "destroyMoon";
/** Déclenche un fleet-save : sondes ET attaques (décision utilisateur) ; pas la destruction de lune (hors périmètre). */
export const triggersSave = (t: Threat) => t.mission !== "destroyMoon";
export const threatLabel = (t: Threat) =>
  t.mission === "espionage" ? "🔍 SONDAGE" : t.mission === "destroyMoon" ? "🌑 DESTRUCTION DE LUNE" : "🚨 ATTAQUE";
/** Composition de la flotte hostile : « 25 croiseurs, 11 GT ». */
export const threatShips = (t: Threat) =>
  (t.types ?? []).filter((x) => x?.count > 0).map((x) => `${x.count} ${SHIP_FR[x.key] ?? x.key}`).join(", ");

/** Ligne lisible : 🚨 ATTAQUE de 2003CP0 — 36 vaisseaux (25 croiseurs, 11 GT) depuis 17:7 → BetweenLands (17:6) · impact dans 5 min 20 */
export function threatDesc(t: Threat, s: State): string {
  const p = s.planets.find((x) => same(x.coords, t.target));
  const cible = `${p?.name ?? t.cibleNom ?? "?"} (${fmt(t.target)})${t.cibleBody === "moon" ? " 🌙" : ""}`;
  const comp = threatShips(t);
  const total = t.total ?? (t.types ?? []).reduce((a, b) => a + (b?.count ?? 0), 0);
  return `${threatLabel(t)}${t.attaquant ? ` de ${t.attaquant}` : ""}`
    + (total ? ` — ${total} vaisseau${total > 1 ? "x" : ""}${comp ? ` (${comp})` : ""}` : "")
    + (t.origine ? ` depuis ${fmt(t.origine)}` : "")
    + ` → ${cible} · impact dans ${etaStr(t.arrivesAt - s.now)}`;
}

export const threatenedPlanetIds = (s: State, threats: Threat[]) =>
  new Set(threats.filter(isAttack).map((t) => s.planets.find((p) => same(p.coords, t.target))?.id).filter(Boolean) as string[]);
