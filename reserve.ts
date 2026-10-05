// Réservation d'une planète : ses ressources sont promises (vaisseaux /fleetbuild livrés, bâtiment financé par Père).
// Tant qu'elle est réservée : ni autobuild, ni /next, ni collecte, ni autodeut, ni autosupply, ni flotte auto n'y touchent.
// Module feuille (aucun import de autobuild.ts / buildfund.ts) pour casser les cycles : buildfund.ts y déclare ses planètes
// à chaque chargement / écriture de build-fund.json.
import { fleetBuildReserved } from "./fleetbuild.ts";

let fundIds = new Set<string>();
export const setFundReserved = (ids: Iterable<string>) => { fundIds = new Set(ids); };
export const fundReserved = (planetId: string) => fundIds.has(planetId);
export const planetReserved = (planetId: string) => fleetBuildReserved(planetId) || fundIds.has(planetId);
/** Raison lisible (vide si la planète est libre). */
export const reservedWhy = (planetId: string) =>
  fleetBuildReserved(planetId) ? "réservée par /fleetbuild" : fundIds.has(planetId) ? "réservée par un financement de bâtiment" : "";
