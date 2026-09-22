// Presets d'attaque — toujours depuis Père, toujours « attendre l'allié » (rallier: true), mission attack.
// Telegram : /p0 <variante> <sys:pos> · /p1 <variante> <sys:pos>. La cible est vérifiée dans la galaxie avant confirmation.
import type { State } from "./spacek-client.ts";
import { PERE, SHIP_FR, fmtDur, parseCoords, prepareFleet, type FleetPlan } from "./core.ts";
import { presetFor } from "./pirates.ts";
import { galaxySystemCached } from "./scan.ts";

export type Preset = { ships: Record<string, number>; rallier: boolean };
export const PRESETS: Record<string, Record<string, Preset>> = {
  p0: {
    under:      { ships: { cruiser: 7, largeCargo: 10 }, rallier: true },
    over:       { ships: { cruiser: 9, largeCargo: 10 }, rallier: true },
    opti_under: { ships: { pathfinder: 11 }, rallier: true },
    opti_over:  { ships: { pathfinder: 13 }, rallier: true },
  },
  p1: {
    under:      { ships: { cruiser: 60, largeCargo: 30 }, rallier: true },
    over:       { ships: { cruiser: 70, largeCargo: 30 }, rallier: true },
    trio:       { ships: { cruiser: 50, largeCargo: 30 }, rallier: true },
    opti_under: { ships: { cruiser: 20, pathfinder: 32 }, rallier: true },
    opti_over:  { ships: { cruiser: 10, pathfinder: 32 }, rallier: true },
    // L'utilisateur a écrit deux fois « trio » (50 croiseurs + 30 GT, puis 5 croiseurs + 32 éclaireurs) :
    // la seconde suit la série opti_* → nommée opti_trio.
    opti_trio:  { ships: { cruiser: 5, pathfinder: 32 }, rallier: true },
  },
  p2: {
    trio:  { ships: { cruiser: 110, largeCargo: 40, pathfinder: 10, battleship: 2 }, rallier: true },
    under: { ships: { cruiser: 110, largeCargo: 40, pathfinder: 20, battleship: 2 }, rallier: true },
    over:  { ships: { cruiser: 110, largeCargo: 40, pathfinder: 30, battleship: 10 }, rallier: true },
  },
};

export const presetsHelp = () =>
  Object.entries(PRESETS).map(([g, vs]) => [`▸ /${g}`, ...Object.entries(vs).map(([v, p]) =>
    `   /${g} ${v} <sys:pos>\n      ${Object.entries(p.ships).map(([k, n]) => `${n} ${SHIP_FR[k] ?? k}`).join(" + ")}`)].join("\n")).join("\n\n");

/** Vérifie la cible dans la galaxie (position 1–15, planète présente, pas à nous) puis prépare l'attaque. */
export async function planPreset(s: State, group: string, variant: string, pos: string, speedPercent = 100): Promise<FleetPlan> {
  const g = PRESETS[group.toLowerCase()];
  if (!g) throw new Error(`Preset inconnu : ${group} (dispo : ${Object.keys(PRESETS).join(", ")})`);
  const pr = g[variant.toLowerCase()];
  if (!pr) throw new Error(`Variante inconnue : ${variant} (dispo pour ${group} : ${Object.keys(g).join(", ")})`);
  const coords = parseCoords(pos);
  if (coords.position < 1 || coords.position > 15) throw new Error(`Position ${coords.position} hors planètes (1–15) : pas d'attaque`);
  const sys = await galaxySystemCached(coords.system);
  const slot = sys.slots.find((x) => x.position === coords.position);
  // Cible valide : une planète d'un autre joueur, OU une cache/convoi pirate (c'est la cible naturelle des presets p0/p1/p2)
  if (!slot || (!slot.planet && !slot.pirate && !slot.convoi)) throw new Error(`Rien en ${pos} (ni planète, ni cache pirate) : pas d'attaque`);
  if (slot.planet && slot.planet.ownerId === s.player.id) throw new Error(`${pos} est ta planète (${slot.planet.name}) : pas d'attaque`);
  const plan = prepareFleet(s, { from: PERE, mission: "attack", coords, ships: pr.ships, speedPercent, rallier: pr.rallier, label: `⚔️ ${group} ${variant}` });
  if (slot.pirate) {
    const expected = presetFor(slot.pirate.tier);
    plan.summary += `\nCible : ☠ ${slot.pirate.nom} ${slot.pirate.tier}${slot.pirate.boss ? " (boss)" : ""}${slot.pirate.expireA ? ` · expire dans ${fmtDur(slot.pirate.expireA - s.now)}` : ""}` +
      (slot.pirate.maitrise ? "\n⚠️ échelon déjà maîtrisé" : "") + (expected && expected !== `/${group.toLowerCase()}` ? `\n⚠️ tier ${slot.pirate.tier} → preset attendu ${expected}` : "");
  } else if (slot.convoi) plan.summary += `\nCible : ☠ convoi pirate ${slot.convoi.tier ?? ""}${slot.convoi.epave ? " (épave, sans escorte)" : ""}`;
  else if (slot.planet) plan.summary += `\nCible : ${slot.planet.name} de ${slot.planet.ownerName}${slot.planet.vacances ? " (vacances)" : ""}${slot.planet.protection ? " 🛡 protégée" : ""}${slot.planet.moon ? " 🌙" : ""}`;
  return plan;
}
