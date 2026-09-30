// Presets d'attaque — toujours depuis Père, toujours « attendre l'allié » (rallier: true), mission attack.
// Telegram : /p0 · /p1 · /p2 <variante> <sys:pos> · /p3 <sys:pos> (p3 : composition calculée sur ce qui est à quai). La cible est vérifiée dans la galaxie avant confirmation.
import type { State } from "./spacek-client.ts";
import { PERE, SHIP_FR, fmtDur, parseCoords, pere, prepareFleet, type FleetPlan } from "./core.ts";
import { presetFor } from "./pirates.ts";
import { galaxySystemCached } from "./scan.ts";

// ships = quantités fixes · max = « jusqu'à N » (borné par ce qui est à quai sur Père) · all = « tout ce qui est à quai » (résolus dans planPreset)
export type Preset = { ships: Record<string, number>; rallier: boolean; max?: Record<string, number>; all?: string[] };
// Convention : « over » envoie toujours plus de vaisseaux que « under ».
export const PRESETS: Record<string, Record<string, Preset>> = {
  p0: {
    under:      { ships: { cruiser: 7, largeCargo: 10 }, rallier: true },
    over:       { ships: { cruiser: 9, largeCargo: 10 }, rallier: true },
    opti_under: { ships: { pathfinder: 11 }, rallier: true },
    opti_over:  { ships: { pathfinder: 13 }, rallier: true },
  },
  p1: {
    under:      { ships: { cruiser: 30, largeCargo: 30 }, rallier: true },
    over:       { ships: { cruiser: 50, largeCargo: 30 }, rallier: true },
    trio:       { ships: { cruiser: 50, largeCargo: 30 }, rallier: true },
    opti_under: { ships: { cruiser: 10, pathfinder: 32 }, rallier: true },
    opti_over:  { ships: { cruiser: 20, pathfinder: 32 }, rallier: true },
    // L'utilisateur a écrit deux fois « trio » (50 croiseurs + 30 GT, puis 5 croiseurs + 32 éclaireurs) :
    // la seconde suit la série opti_* → nommée opti_trio.
    opti_trio:  { ships: { cruiser: 5, pathfinder: 32 }, rallier: true },
  },
  p2: {
    trio:  { ships: { cruiser: 110, largeCargo: 40, pathfinder: 10, battleship: 2 }, rallier: true },
    under: { ships: { cruiser: 140, largeCargo: 50, pathfinder: 50 }, rallier: true },
    over:  { ships: { cruiser: 160, largeCargo: 50, pathfinder: 50 }, rallier: true },
  },
  // Caches T3 : composition dynamique — on laisse les vaisseaux lents (bombardiers, destructeurs, recycleurs…)
  p3: {
    tout: { ships: {}, max: { largeCargo: 150 }, all: ["cruiser", "pathfinder", "battleship", "battlecruiser"], rallier: true },
  },
};

const compoText = (p: Preset) => [
  ...Object.entries(p.max ?? {}).map(([k, n]) => `jusqu'à ${n} ${SHIP_FR[k] ?? k}`),
  ...Object.entries(p.ships).map(([k, n]) => `${n} ${SHIP_FR[k] ?? k}`),
  ...(p.all ?? []).map((k) => `tous les ${SHIP_FR[k] ?? k}`)].join(" + ");

/** Un groupe de presets : titre + une entrée par variante (commande et composition). Source unique de /presets, /help et /tips. */
export const presetGroupHelp = (g: string) => {
  const vs = PRESETS[g.toLowerCase()];
  if (!vs) throw new Error(`Preset inconnu : ${g} (dispo : ${Object.keys(PRESETS).join(", ")})`);
  return [`▸ /${g}`, ...Object.entries(vs).map(([v, p]) =>
    `   /${g}${Object.keys(vs).length > 1 ? ` ${v}` : ""} <sys:pos>\n      ${compoText(p)}`)].join("\n");
};

export const presetsHelp = () => Object.keys(PRESETS).map(presetGroupHelp).join("\n\n");

/** Vérifie la cible dans la galaxie (position 1–15, planète présente, pas à nous) puis prépare l'attaque. */
export async function planPreset(s: State, group: string, variant: string | undefined, pos: string, speedPercent = 100): Promise<FleetPlan> {
  const g = PRESETS[group.toLowerCase()];
  if (!g) throw new Error(`Preset inconnu : ${group} (dispo : ${Object.keys(PRESETS).join(", ")})`);
  const vKeys = Object.keys(g);
  if (!variant && vKeys.length === 1) variant = vKeys[0]; // groupe à variante unique : variante facultative
  const pr = g[(variant ?? "").toLowerCase()];
  if (!pr || !variant) throw new Error(`Variante inconnue : ${variant} (dispo pour ${group} : ${Object.keys(g).join(", ")})`);
  const coords = parseCoords(pos);
  if (coords.position < 1 || coords.position > 15) throw new Error(`Position ${coords.position} hors planètes (1–15) : pas d'attaque`);
  const sys = await galaxySystemCached(coords.system);
  const slot = sys.slots.find((x) => x.position === coords.position);
  // Cible valide : une planète d'un autre joueur, OU une cache/convoi pirate (c'est la cible naturelle des presets p0–p3)
  if (!slot || (!slot.planet && !slot.pirate && !slot.convoi)) throw new Error(`Rien en ${pos} (ni planète, ni cache pirate) : pas d'attaque`);
  if (slot.planet && slot.planet.ownerId === s.player.id) throw new Error(`${pos} est ta planète (${slot.planet.name}) : pas d'attaque`);
  // Composition réelle : quantités fixes + « jusqu'à N » + « tout » d'après ce qui est à quai sur Père (types à 0 omis)
  const docked = pere(s).ships, ships = { ...pr.ships }, warns: string[] = [];
  for (const [k, n] of Object.entries(pr.max ?? {})) {
    const d = docked[k] ?? 0;
    if (d > 0) ships[k] = Math.min(n, d);
    if (d < n) warns.push(`⚠️ seulement ${d} ${SHIP_FR[k] ?? k} à quai (${n} visés)`);
  }
  for (const k of pr.all ?? []) if ((docked[k] ?? 0) > 0) ships[k] = docked[k];
  if (pr.all && !pr.all.some((k) => (docked[k] ?? 0) > 0)) throw new Error(`Aucun vaisseau de combat à quai sur Père (${pr.all.map((k) => SHIP_FR[k] ?? k).join(", ")}) : pas d'attaque`);
  const plan = prepareFleet(s, { from: PERE, mission: "attack", coords, ships, speedPercent, rallier: pr.rallier, label: `⚔️ ${group} ${variant}` });
  if (warns.length) plan.summary += `\n${warns.join("\n")}`;
  if (slot.pirate) {
    const expected = presetFor(slot.pirate.tier);
    plan.summary += `\nCible : ☠ ${slot.pirate.nom} ${slot.pirate.tier}${slot.pirate.boss ? " (boss)" : ""}${slot.pirate.expireA ? ` · expire dans ${fmtDur(slot.pirate.expireA - s.now)}` : ""}` +
      (slot.pirate.maitrise ? "\n⚠️ échelon déjà maîtrisé" : "") + (expected && expected !== `/${group.toLowerCase()}` ? `\n⚠️ tier ${slot.pirate.tier} → preset attendu ${expected}` : "");
  } else if (slot.convoi) plan.summary += `\nCible : ☠ convoi pirate ${slot.convoi.tier ?? ""}${slot.convoi.epave ? " (épave, sans escorte)" : ""}`;
  else if (slot.planet) plan.summary += `\nCible : ${slot.planet.name} de ${slot.planet.ownerName}${slot.planet.vacances ? " (vacances)" : ""}${slot.planet.protection ? " 🛡 protégée" : ""}${slot.planet.moon ? " 🌙" : ""}`;
  return plan;
}
