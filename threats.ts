// Menaces en approche : parsing de `menaces` / `incoming` / `alertesVives` de /state.
// Format lu dans le bundle client le 21/09/2026 [BUNDLE], jamais vu en live :
//   menaces[] = { fleetId, mission, attaquant, cible: { nom, coords }, arrivesAt } ; incoming[] indexé par fleetId aussi.
// Le brut est loggé (incoming-samples.jsonl) et notifié à chaque changement : au pire un JSON moche, jamais le silence.
import type { Coords, State } from "./spacek-client.ts";
import { alert, appendJsonl, same, xy } from "./core.ts";

export type Threat = { id: string; mission?: string; arrivesAt: number; target: Coords; attaquant?: string; cibleNom?: string; raw: any };
let lastIncomingSample = "";

export function parseThreats(s: State): Threat[] {
  const raw = [...(s.incoming ?? []), ...(s.menaces ?? []), ...(s.alertesVives ?? [])];
  if (raw.length) {
    const sample = JSON.stringify({ incoming: s.incoming, menaces: s.menaces, alertesVives: s.alertesVives });
    if (sample !== lastIncomingSample) {
      lastIncomingSample = sample;
      appendJsonl("incoming-samples.jsonl", { now: s.now, ...JSON.parse(sample) });
      alert(`⚠️ ACTIVITÉ ENTRANTE (brut, ${raw.length} élément(s)) :\n${sample.slice(0, 1500)}`);
    }
  }
  const out = new Map<string, Threat>();
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const id = String(f.fleetId ?? f.id ?? "");
    const arrivesAt = Number(f.arrivesAt ?? f.impactAt ?? NaN);
    const target = f.cible?.coords ?? f.target?.coords ?? f.coords;
    if (!id || !Number.isFinite(arrivesAt) || !target?.system) continue;
    out.set(id, { id, mission: f.mission, arrivesAt, target: xy(target), attaquant: f.attaquant, cibleNom: f.cible?.nom, raw: f });
  }
  return [...out.values()];
}
/** Même logique que l'UI du jeu [BUNDLE] : dans `menaces`, tout ce qui n'est ni sondage ni destruction de lune est affiché « Attaque ». */
export const isAttack = (t: Threat) => t.mission !== "espionage" && t.mission !== "destroyMoon";
/** Déclenche un fleet-save : sondes ET attaques (décision utilisateur) ; pas la destruction de lune (hors périmètre). */
export const triggersSave = (t: Threat) => t.mission !== "destroyMoon";
export const threatLabel = (t: Threat) => t.mission === "espionage" ? "🔍 SONDAGE" : t.mission === "destroyMoon" ? "🌑 DESTRUCTION DE LUNE" : "🚨 ATTAQUE";
export const threatenedPlanetIds = (s: State, threats: Threat[]) =>
  new Set(threats.filter(isAttack).map((t) => s.planets.find((p) => same(p.coords, t.target))?.id).filter(Boolean) as string[]);
