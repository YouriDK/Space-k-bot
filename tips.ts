// /tips : index « clean » des commandes (une ligne chacune) et fiche détaillée par commande (/tips pirates, /tips p1, /tips autosupply…).
// Registre unique : toute commande du switch de telegram.ts doit y figurer (aliases compris). Les détails lisent les valeurs vivantes
// (PRESETS, cible de ravitaillement, garde deut des expéditions…) plutôt que de les recopier. Aucun import de telegram.ts / bot.ts (pas de cycle).
import { MISSIONS } from "./spacek-client.ts";
import { PRESETS, presetGroupHelp } from "./presets.ts";
import { DEUT_CAP, DEUT_COLLECT_MIN } from "./deut.ts";
import { SUPPLY_EVERY_H, supplyTargetStr } from "./supply.ts";
import { EXPLO_AUTO_COUNT, EXPLO_AUTO_HOURS, EXPLO_DEUT_KEEP, EXPLO_911_HOURS } from "./expedition.ts";
import { OBJECTIFS } from "./autobuild.ts";
import { DEUT_RESERVE, num } from "./core.ts";
import { AUTOFLEET_EVERY_MS, AUTOFLEET_LOT_MS, AUTOFLEET_MIN_MS } from "./autofleet.ts";

type Tip = { names: string[]; group: string; usage: string; desc: string; detail?: string | (() => string) };

const G = { lecture: "👁 Lecture", raids: "⚔️ Raids", scans: "🔍 Scans et expéditions", supply: "📦 Ravitaillement", build: "🏗 Construction",
  auto: "🛡 Automatismes et défense", divers: "🔧 Divers", generic: "🧰 Génériques (avancé)" } as const;

const fmtN = (n: number) => n.toLocaleString("fr-FR");
const probes = () => process.env.SCAN_PROBES || 15;
const pirateEveryMin = () => Math.round((Number(process.env.PIRATE_CHECK_MS) || 5 * 60_000) / 60_000);
const PLANETE = "<planète> = pere · fils · oncle · cousin · bl (ou id pl_xx, ou coords 6:7)";

/** Fiche d'un groupe de raids : variantes (depuis PRESETS) + rappels communs. */
const raidDetail = (g: "p0" | "p1" | "p2" | "p3") => () => {
  const tier = `T${g[1]}`, seule = Object.keys(PRESETS[g]).length === 1;
  return [
    `Flotte envoyée (générée depuis les presets) :`,
    presetGroupHelp(g),
    "",
    `Cible : cache pirate ${tier} ou convoi — le récap avertit si le tier ne correspond pas au preset. Une planète d'un autre joueur est aussi acceptée.`,
    `Départ de Père, « attendre l'allié » toujours coché. La cible est vérifiée dans la galaxie (position 1–15, quelque chose à cette position, pas ta planète).`,
    `Part après confirmation ✅ (60 s pour valider).`,
    g === "p3"
      ? `Composition calculée sur ce qui est à quai sur Père au moment de la commande ; les vaisseaux lents restent. Variante facultative : /p3 <sys:pos> suffit. Moins de GT que visé → avertissement ; aucun vaisseau de combat → refus.`
      : `« over » envoie plus de vaisseaux que « under ». Ex. : /${g} ${Object.keys(PRESETS[g])[0]} 12:9`,
    `Caches en cours et preset conseillé : /pirates`,
  ].join("\n");
};

const TIPS: Tip[] = [
  // ---- Lecture
  { names: ["status"], group: G.lecture, usage: "/status", desc: "ressources, slots, flottes, menaces, latence",
    detail: "Une ligne de slots (flottes en vol, menaces, expéditions), l'état des automatismes, la latence du poll, puis chaque planète avec ses ressources et sa file en cours (bâtiment / chantier), et la recherche en cours." },
  { names: ["flotte", "flottes"], group: G.lecture, usage: "/flotte", desc: "mes vaisseaux par planète + flottes en vol",
    detail: "Vaisseaux de chaque planète (Père en premier, satellites exclus), puis les flottes en vol avec mission et destination." },
  { names: ["planets"], group: G.lecture, usage: "/planets", desc: "planètes : id, ressources / capacité, vaisseaux",
    detail: "Utile pour connaître l'id (pl_xx) d'une planète : chaque planète avec ses ressources, ses capacités de stockage et ses vaisseaux." },
  { names: ["fleets"], group: G.lecture, usage: "/fleets", desc: "flottes en vol (id, phase, arrivée)",
    detail: "Une ligne par flotte : id (à donner à /recall), mission, phase, vaisseaux, destination et temps restant." },
  { names: ["threats"], group: G.lecture, usage: "/threats", desc: "menaces en approche",
    detail: "Attaques et sondages qui arrivent sur tes planètes. Le fleet-save (/save) se base sur ces menaces." },
  { names: ["pirates"], group: G.lecture, usage: "/pirates [p1|p2|p3]", desc: "caches pirates connues + preset conseillé",
    detail: () => [
      `Affiche les caches et convois pirates connus : nom, tier (T0–T3), position système:position, expiration, « échelon déjà maîtrisé » le cas échéant, et le preset conseillé (T0→/p0, T1→/p1, T2→/p2, T3→/p3) avec la position à copier.`,
      `Filtre : /pirates p1 · /pirates p2 p3 (plusieurs possibles ; t1, T1 acceptés).`,
      `C'est le dernier relevé du bot (toutes les ${pirateEveryMin()} min, PIRATE_CHECK_MS), sans appel supplémentaire au jeu : l'âge du relevé est indiqué en tête.`,
      `Les nouvelles caches sont aussi notifiées automatiquement (🏴‍☠️ NOUVELLE CACHE), sur Telegram et Discord.`,
    ].join("\n") },
  { names: ["joueur", "player"], group: G.lecture, usage: "/joueur <nom>", desc: "planètes, rang et puissance d'un joueur",
    detail: "Recherche dans le classement (nom exact, sinon contenant le texte) puis dans la galaxie : rang, nombre de planètes, puissance, développement, et chaque planète avec sa position. Lecture seule, aucune sonde envoyée. Pour sonder : /scan." },
  { names: ["presets"], group: G.lecture, usage: "/presets", desc: "toutes les flottes des raids /p0 à /p3",
    detail: "Liste complète des variantes de /p0 /p1 /p2 /p3 avec leur composition. Pour une seule famille : /tips p1." },
  { names: ["flags"], group: G.lecture, usage: "/flags", desc: "état des automatismes",
    detail: "save (armé / observation), ravitaillement auto, collect, recyclage, récupération, expédition auto, deut→Père, autobuild. Se règle avec /save, /collect, /recycle, /recup, /autoexplo, /autosupply, /autodeut, /autobuild, /pause." },
  { names: ["salvage", "recup_list"], group: G.lecture, usage: "/salvage", desc: "débris et cargaisons visibles dans la galaxie",
    detail: "Lit la galaxie (un appel carte + les systèmes concernés) : champs de débris (avec le seuil de recyclage), cargaisons abandonnées (éclaireurs nécessaires, temps avant extinction), quota journalier de cargaisons, et l'état de /recycle et /recup. N'envoie rien." },

  // ---- Raids
  { names: ["p0"], group: G.raids, usage: "/p0 <variante> <sys:pos>", desc: "raid sur cache T0", detail: raidDetail("p0") },
  { names: ["p1"], group: G.raids, usage: "/p1 <variante> <sys:pos>", desc: "raid sur cache T1", detail: raidDetail("p1") },
  { names: ["p2"], group: G.raids, usage: "/p2 <variante> <sys:pos>", desc: "raid sur cache T2", detail: raidDetail("p2") },
  { names: ["p3"], group: G.raids, usage: "/p3 <sys:pos>", desc: "raid sur cache T3 (flotte calculée à quai)", detail: raidDetail("p3") },

  // ---- Scans et expéditions
  { names: ["scan"], group: G.scans, usage: "/scan <joueur>  ·  /scan_<joueur>", desc: "sonde toutes les planètes d'un joueur",
    detail: () => [
      `Envoie ${probes()} sondes (SCAN_PROBES) depuis Père sur CHAQUE planète du joueur : une flotte par planète, toutes en même temps.`,
      `Part immédiatement, sans confirmation ; un récap ✅/❌ par planète suit.`,
      `Pas assez de sondes → réparties à parts égales (sous 1 par planète : refus). Pas assez de slots → seules les premières planètes.`,
      `Raccourci : /scan_Thomas, /scan_2003CP0 (tout nom marche). Pour voir les planètes sans sonder : /joueur <nom>.`,
    ].join("\n") },
  { names: ["explo"], group: G.scans, usage: "/explo opti <h> · /explo 911 [h]", desc: "expédition depuis Père vers la position 16",
    detail: () => [
      `Depuis Père vers la position 16 de son système, mission expédition, après confirmation ✅.`,
      `/explo opti <h> — 10 éclaireurs + 100 GT, durée <h> (obligatoire).`,
      `/explo 911 [h] — tous les éclaireurs, GT, VB et croiseurs de Père, toutes les ressources embarquables, en gardant ${fmtN(EXPLO_DEUT_KEEP)} deut sur Père. Durée par défaut : ${EXPLO_911_HOURS} h.`,
      `La durée est bornée au maximum autorisé (min 1 h). Refus clair si expéditions non débloquées, aucun slot d'expédition, quota 24 h atteint ou système saturé.`,
    ].join("\n") },
  { names: ["autoexplo", "explo_auto"], group: G.scans, usage: "/autoexplo [on|off]", desc: "toujours deux expéditions en vol",
    detail: () => [
      `Garde en permanence ${EXPLO_AUTO_COUNT} expéditions en vol (EXPLO_AUTO_COUNT) : 10 éclaireurs + 100 GT chacune depuis Père vers la position 16, ${EXPLO_AUTO_HOURS} h à chaque fois (EXPLO_AUTO_HOURS). Dès qu'une est entièrement rentrée, la suivante part. Désactivé par défaut.`,
      `/autoexplo on — active (immédiat, sans confirmation) · /autoexplo off — désactive`,
      `/autoexplo — état : on/off, expédition en vol et son retour, quota du jour, raison de blocage éventuelle.`,
      `Rien ne part si Père est menacée. Quota 24 h atteint, aucun slot ou vaisseaux manquants : aucun envoi, une seule alerte par raison, nouvel essai chaque minute. Envoi refusé : alerte, nouvel essai 15 min plus tard. /pause coupe l'automatisme, /resume le rétablit.`,
    ].join("\n") },

  // ---- Ravitaillement
  { names: ["supply"], group: G.supply, usage: "/supply <planète> <M> <C> <D>", desc: "envoie des ressources de Père (en milliers)",
    detail: () => [
      `Ravitaille une planète depuis Père, immédiatement (pas de confirmation) ; un récap ✅/❌ par flotte suit.`,
      `Quantités en milliers : 40 = 40 000 ; 40k et 1m acceptés ; brut accepté à partir de 1000.`,
      `Ex. : /supply fils 40 14 90 → 40 000 M, 14 000 C, 90 000 D.`,
      `PT d'abord (plus rapides) dans une flotte à part, GT en complément dans une 2e flotte. Un seul slot libre → flotte mixte, avertissement.`,
      `Limité au stock de Père (garde ${fmtN(DEUT_RESERVE)} deut pour le carburant), sans plafond lié à la capacité de la destination.`,
      PLANETE,
    ].join("\n") },
  { names: ["autosupply", "supply_auto"], group: G.supply, usage: "/autosupply [<planète>] [on|off]", desc: "auto-ravitaillement par colonie",
    detail: () => [
      `Une vérification toutes les ${SUPPLY_EVERY_H} h par colonie activée : Père la complète jusqu'à ${supplyTargetStr()} (au millier près), GT puis PT. Tout est désactivé par défaut.`,
      `/autosupply fils on — active (1er passage dans la minute) · /autosupply fils off — désactive`,
      `/autosupply fils — état : prochain passage, ce qui manque, ce qui partirait`,
      `/autosupply — état de toutes les colonies · /autosupply off — désactive tout`,
      `Part sans confirmation. Limité au stock de Père ; réessaie chaque minute si menace, transport déjà en route ou pas de transporteur / slot. Père ne peut pas être activé (c'est la source). /pause suspend tout, les activations sont conservées.`,
      `Si /autodeut est actif, la cible de deut est plafonnée à ${fmtN(DEUT_CAP)} : l'autosupply ne remplit jamais le deut au-delà.`,
    ].join("\n") },
  { names: ["autodeut", "deut_auto"], group: G.supply, usage: "/autodeut [on|off]", desc: "ramène le deut excédentaire des colonies à Père",
    detail: () => [
      `Plafond de deut de ${fmtN(DEUT_CAP)} (DEUT_CAP) sur chaque planète autre que Père : l'excédent repart vers Père avec les transporteurs SUR LA COLONIE (GT puis PT, une seule flotte, deut seul). Désactivé par défaut.`,
      `/autodeut on — active (immédiat, sans confirmation) · /autodeut off — désactive`,
      `/autodeut — état : on/off, plafond, puis par colonie le deut, l'excédent, les transporteurs sur place et ce qui partirait (ou pourquoi rien).`,
      `Une évaluation par minute ; rien sous ${fmtN(DEUT_COLLECT_MIN)} d'excédent (DEUT_COLLECT_MIN). Rien si Père ou la colonie est menacée, si la colonie est réservée (/fleetbuild, financement de bâtiment) ou si un transport part déjà d'elle vers Père. Le carburant est pris sur les ${fmtN(DEUT_CAP)} qui restent.`,
      `Aucun transporteur sur place : pas d'envoi, une seule alerte par colonie (déploie des GT : /deploy pere <planète> largeCargo=2). Pas de slot libre : nouvel essai à la minute suivante. Envoi refusé : alerte, nouvel essai vers cette colonie 15 min plus tard. /pause coupe l'automatisme, /resume le rétablit.`,
      `Sur les colonies en auto-ravitaillement, la cible de deut est alors plafonnée à ${fmtN(DEUT_CAP)} (pas d'aller-retour).`,
    ].join("\n") },

  // ---- Construction
  { names: ["next"], group: G.build, usage: "/next [<planète>] [<clé>|labo [<clé>]|off]", desc: "construction / recherche mise en attente",
    detail: [
      `Met un ordre en attente : il part dès que la file se libère, même la nuit. Un ordre par planète (+ une recherche), persisté au redémarrage. Pas de confirmation : choisir dans la liste vaut validation.`,
      `/next — boutons : choisir la planète puis le bâtiment`,
      `/next <planète> — liste des bâtiments · /next <planète> <clé> — mise en attente directe · /next <planète> off — annule`,
      `/next <planète> labo — liste des recherches · /next <planète> labo <clé> — mise en attente · /next labo off — annule (sans planète : meilleur labo)`,
      `Ressources manquantes ou refus du jeu : l'ordre reste en attente, réessai chaque minute. Passe avant l'auto-construction sur la planète. Voir aussi /nexts.`,
    ].join("\n") },
  { names: ["nexts", "attente"], group: G.build, usage: "/nexts", desc: "ce qui est en attente par planète",
    detail: "Liste les ordres /next en attente : la recherche et chaque planète." },
  { names: ["plan"], group: G.build, usage: "/plan", desc: "auto-construction : état, prochain bâtiment, financements",
    detail: "Planètes où /autobuild est actif, objectifs, règles (énergie, réservoir plein), état du financement par Père et de Graviton auto, puis pour chaque planète : plafonds propres (ex. Père labo 12), réservation éventuelle, prochain bâtiment choisi (coût, durée, raison), « besoin » à financer par Père et bâtiments sautés. En fin : l'état de Graviton et les commandes de financement en cours (manque, voyages, livré)." },
  { names: ["batiments", "buildings"], group: G.build, usage: "/batiments <planète>", desc: "bâtiments : niveau, coût, durée",
    detail: "Pour une planète : énergie, champs utilisés, et chaque bâtiment constructible avec niveau actuel → suivant, coût, durée, 🔒 si verrouillé (et ce qui manque). Lecture seule ; pour construire : /build ou /next." },
  { names: ["fleetbuild"], group: G.build, usage: "/fleetbuild [<planète> [<vaisseau> <qté>]]", desc: "vaisseaux construits sur une planète, payés par Père",
    detail: () => [
      `Répartit la construction de vaisseaux sur les chantiers des colonies : Père paie, la planète choisie construit.`,
      `/fleetbuild — boutons : la planète (niveau du chantier), puis le vaisseau (débloqués sur CETTE planète : coût et durée par unité), puis la quantité (1, 5, 10… et « max » = ce que Père peut payer ET transporter). Après les boutons de quantité, tu peux aussi taper un nombre seul (5 min) ; une commande /… annule la saisie.`,
      `/fleetbuild <planète> <vaisseau> <qté> — direct au récap (qté ou max). Vaisseau : clé API (cruiser) ou nom (croiseur(s), gt, pt, vb, éclaireur, traqueur, sonde, recycleur…). /fleetbuild <planète> [<vaisseau>] — ouvre la liste à cette étape.`,
      `Récap ✅/❌ (60 s) : N × vaisseau, coût total, durée estimée (N × durée unitaire), transport prévu, ce qui reste sur Père.`,
      `Confirmé : Père envoie le coût total exact en une flotte transport (GT puis PT), sans déduire le stock de la planète, en gardant ${fmtN(DEUT_RESERVE)} deut. Cible = Père : pas de transport, lancement immédiat.`,
      `Refus avant tout envoi, chiffres à l'appui : vaisseau verrouillé, pas de chantier, Père trop pauvre (max finançable), transporteurs insuffisants (combien il en faut), aucun slot.`,
      `À l'arrivée, dès que le stock de la planète couvre le coût, le chantier lance la construction (🚀). Stock insuffisant ou refus du jeu : la commande reste, nouvel essai chaque minute, une alerte par raison, jamais d'abandon automatique.`,
      `Entre l'arrivée et le lancement, la planète est réservée : ni auto-construction, ni /next, ni collecte, ni autodeut, ni autosupply, ni flotte auto n'y touchent. /pause ne suspend pas ces commandes.`,
      `/fleetbuild liste — commandes en cours (n°, planète, quantité, état) · /fleetbuild annule <n°> — retire la commande, sans rappeler le transport (/recall pour ça).`,
      PLANETE,
    ].join("\n") },
  { names: ["autobuild"], group: G.build, usage: "/autobuild [<planète>] on|off", desc: "auto-construction par planète",
    detail: () => [
      `Enchaîne les bâtiments d'une planète selon les objectifs : ${OBJECTIFS.map((o) => `${o.key} ${o.max}`).join(" > ")}. Père : labo 12 (plafond propre, débloque Graviton).`,
      `/autobuild fils on · /autobuild fils off · /autobuild fils (état) · /autobuild off (désactive toutes les planètes)`,
      `Énergie déjà négative → centrale d'abord. Pas les ressources → on passe au suivant. Réservoir plein → on l'agrandit avant la mine ; en dernier, réservoir plein alors que la mine est au plafond → agrandi, payé sur place. Énergie qui passerait en négatif → centrale d'abord. Délai de quelques minutes après chaque fin.`,
      `Financement (/autobuild finance, ON par défaut) : le premier bâtiment écarté faute de ressources est le « besoin » ; Père le finance (/tips finance). Graviton auto : /autobuild graviton on|off (ON par défaut).`,
      `Les objectifs se règlent dans build-plan.json (rechargé à chaud ; plafonds par planète dans « plafonds »). Sans confirmation. /plan montre l'état ; /pause coupe aussi l'auto-construction, le financement et Graviton auto.`,
    ].join("\n") },

  { names: ["finance", "financement"], group: G.build, usage: "/autobuild finance on|off|annule <pl>", desc: "Père finance les bâtiments des colonies (ON par défaut)",
    detail: () => [
      `Quand une colonie à autobuild activé a un « besoin » (premier bâtiment de son ordre de décision écarté UNIQUEMENT faute de ressources), Père lui livre le manque (coût − stock de la colonie, recalculé à chaque voyage) puis le bot lance le bâtiment dès que le stock le couvre et que la file est libre. Une commande au plus par colonie ; jamais pour Père (il paie sur place).`,
      `Voyages : GT puis PT à quai sur Père, stock de Père moins ${fmtN(DEUT_RESERVE)} deut, un slot libre ; plusieurs voyages si la soute ne suffit pas, un seul en vol à la fois par commande. Rien vers une planète menacée ni depuis Père menacé.`,
      `Dès qu'une commande existe, la colonie est réservée jusqu'au lancement : ni autobuild, ni /next, ni collecte, ni autodeut, ni autosupply, ni flotte auto n'y touchent. La flotte auto attend tant qu'un financement manque de ressources.`,
      `Besoin disparu (niveau atteint, bâtiment lancé à la main, autobuild désactivé) : commande retirée avec alerte, les ressources restent sur place. Refus du jeu : nouvel essai chaque minute, une alerte par raison.`,
      `/autobuild finance on|off — allumé par défaut ; off = plus de nouvelle commande, celles en cours vont au bout · /autobuild finance — état · /autobuild finance annule <planète> — retire la commande (le transport n'est pas rappelé). Détail dans /plan. /pause suspend tout.`,
    ].join("\n") },
  { names: ["graviton"], group: G.build, usage: "/autobuild graviton on|off", desc: "Graviton lancé automatiquement (ON par défaut)",
    detail: "Dès qu'aucune recherche n'est en cours et que Graviton apparaît dans les recherches disponibles (labo de Père à 12), le bot la lance depuis Père, avant toute recherche mise en attente par /next. Refus du jeu (ressources, énergie…) : une alerte par raison, nouvel essai toutes les 10 min. Une fois lancée : alerte, et on n'y revient plus. Son coût entre dans le plancher de Père (/autofleet). /autobuild graviton — état. /pause la suspend." },
  { names: ["autofleet", "flotte_auto"], group: G.build, usage: "/autofleet [<planète> …]", desc: "flotte automatique sur le surplus de Père (ON par défaut)",
    detail: () => [
      `Un type de vaisseau par planète, construit sur son chantier et payé par Père, uniquement avec le SURPLUS au-dessus du plancher : le coût du prochain bâtiment de chaque planète à autobuild (besoin des colonies, prochain objectif de Père), plus Graviton s'il est visible et pas lancé, plus ${fmtN(DEUT_RESERVE)} deut. Rien tant qu'un financement de bâtiment attend.`,
      `Par défaut, toutes activées : BetweenLands GT, Cousin croiseurs, Fils destructeurs, Oncle éclaireurs, Père VB, sans limite.`,
      `Une décision toutes les ${Math.round(AUTOFLEET_EVERY_MS / 60_000)} min, un lot par décision, pour la planète au chantier libre servie le moins récemment. Lot ≈ ${Math.round(AUTOFLEET_LOT_MS / 3_600_000)} h de chantier au plus (le chantier se libère pour ses améliorations), limité aussi par le surplus, les transporteurs à quai sur Père et le max ; rien sous ${Math.round(AUTOFLEET_MIN_MS / 60_000)} min de chantier sauf si le max le limite (AUTOFLEET_EVERY_MIN, AUTOFLEET_LOT_H, AUTOFLEET_MIN_LOT_MIN).`,
      `Lancement comme /fleetbuild : transport depuis Père puis lancement à l'arrivée (visible dans /fleetbuild liste), direct sur Père. Une alerte par lot.`,
      `/autofleet — résumé : par planète type, on/off, à quai, en file, prochain lot ou blocage ; plancher et surplus de Père.`,
      `/autofleet fils on|off · /autofleet fils croiseurs [50|max] (change le type, refusé s'il est verrouillé ; 50 = nombre visé à quai, max = illimité) · /autofleet fils max 50|illimite. Immédiat, sans confirmation. /pause suspend ; rien si Père ou la planète est menacée.`,
      PLANETE,
    ].join("\n") },

  // ---- Automatismes et défense
  { names: ["save"], group: G.auto, usage: "/save on|off", desc: "fleet-save : armer / observation",
    detail: () => `on : ${Math.round(num("SAVE_BEFORE_MS", 10_000) / 1000)} s avant une sonde ou une attaque sur une planète, toute la flotte et les ressources décollent vers la planète voisine, rappel juste après. off : mode observation, le bot annonce seulement « j'AURAIS décollé ». Immédiat, sans confirmation.` },
  { names: ["collect"], group: G.auto, usage: "/collect on|off", desc: "vide les colonies qui débordent vers Père",
    detail: "Toutes les minutes : si une ressource dépasse un seuil de la capacité (COLLECT_THRESHOLD, 90 % par défaut), le surplus au-dessus de COLLECT_KEEP (50 %) part vers Père avec les transporteurs sur place. Jamais depuis/vers une planète menacée. Immédiat, sans confirmation." },
  { names: ["recycle"], group: G.auto, usage: "/recycle on|off", desc: "recycleurs sur les champs de débris",
    detail: () => `Envoie ${process.env.RECYCLERS_PER_FIELD || 2} recycleurs sur les champs de débris dont métal + cristal dépasse ${fmtN(Number(process.env.DEBRIS_MIN) || 40_000)} (DEBRIS_MIN), depuis la planète la plus proche qui en a. Relevé toutes les 10 min. Voir ce qui est visible : /salvage.` },
  { names: ["recup"], group: G.auto, usage: "/recup on|off", desc: "éclaireurs sur les cargaisons abandonnées",
    detail: "Envoie des éclaireurs (1 par tranche de 10 000 de cargaison annoncée) sur les cargaisons abandonnées, depuis la planète la plus proche qui en a. Respecte le quota journalier et saute une cible qui s'éteint avant l'arrivée ; sans flotte ou slot libre, n'envoie rien. Voir : /salvage." },
  { names: ["recall"], group: G.auto, usage: "/recall <fleetId>", desc: "rappelle une flotte (immédiat)",
    detail: "Rappel immédiat, sans confirmation (urgence). L'id de flotte se lit dans /fleets." },
  { names: ["pause"], group: G.auto, usage: "/pause", desc: "coupe tous les automatismes",
    detail: "Coupe save, collect, recyclage, récupération, expédition auto, deut→Père, auto-construction (financement et Graviton auto compris), flotte auto et auto-ravitaillement. Les activations par planète (/autobuild, /autosupply) et leurs échéances sont conservées. /resume restaure l'état d'avant." },
  { names: ["resume"], group: G.auto, usage: "/resume", desc: "restaure les automatismes",
    detail: "Remet les automatismes dans l'état où ils étaient avant /pause." },

  // ---- Divers
  { names: ["help", "start"], group: G.divers, usage: "/help [full]", desc: "aide détaillée (full : commandes génériques)",
    detail: "L'aide longue, par sections. /help full : la liste compacte avec les commandes génériques. Pour une vue courte : /tips." },
  { names: ["tips", "tip"], group: G.divers, usage: "/tips [<commande>]", desc: "cette liste · le détail d'une commande",
    detail: "/tips — l'index court de toutes les commandes (une ligne chacune). /tips <commande> — la fiche : ce que ça fait, arguments, exemples, confirmation ou non. Accepte /pirates, p1, autosupply, scan_Thomas… Seul le premier mot est pris en compte." },
  { names: ["token"], group: G.divers, usage: "/token <refresh_token>", desc: "renouvelle le token Keycloak",
    detail: "Remplace le refresh token Keycloak et re-teste l'authentification tout de suite. Le jeton se renouvelle tout seul tant que le bot tourne ; il n'expire qu'après 7 jours d'inactivité. Le message n'est pas journalisé en clair." },
  { names: ["maj", "update"], group: G.divers, usage: "/maj", desc: "met le bot à jour depuis GitHub (retour arrière auto)",
    detail: () => [
      "Récupère le dépôt GitHub sur le téléphone (clone créé au premier appel), liste les commits à déployer puis demande ✅.",
      "À la confirmation, update.sh sauvegarde le code actuel, copie les nouveaux fichiers et redémarre le bot. Le nouveau bot annonce « ✅ Mise à jour en place » ; sans signe de vie sous 90 s, l'ancienne version est remise automatiquement et un message ❌ arrive avec les dernières lignes de pm2 logs.",
      "Jamais écrasés : les *.json (flags, build-plan, supply, fleet-build, build-fund, auto-fleet, package.json…), .env, refresh_token.txt, les *.jsonl. package.json différent → signalé, npm install reste à faire à la main.",
      "Refusé si un fleet-save est en vol, ou si le save est armé et qu'une menace arrive dans moins de 5 min (revérifié au ✅). Les confirmations ✅ en attente sont perdues au redémarrage.",
      "Journal sur le téléphone : ~/spacek-bot/update.log · sauvegardes : ~/spacek-backups (10 dernières).",
    ].join("\n") },

  // ---- Génériques
  { names: ["send"], group: G.generic, usage: "/send <pl> <mission> <cible> <k=n,…>", desc: "flotte libre (+ m= c= d= speed=)",
    detail: () => [
      `Envoie une flotte quelconque après confirmation ✅.`,
      `/send <planète> <mission> <sys:pos|planète> <k=n,k=n> [m=… c=… d=… speed=…]`,
      `Missions : ${MISSIONS.join(", ")}. Vaisseaux : clés API (cruiser=7,largeCargo=10). Cargaison m/c/d en unités brutes, speed en % (100 par défaut).`,
      `Ex. : /send pere deploy fils cruiser=5,largeCargo=2 · ${PLANETE}`,
    ].join("\n") },
  { names: ["transport"], group: G.generic, usage: "/transport <de> <vers> <M> <C> <D>", desc: "transport (GT d'abord, PT en complément)",
    detail: "Transport de ressources en unités brutes (pas en milliers), après confirmation ✅. Choisit les GT d'abord, puis des PT pour le reste, d'après ce qui est sur la planète de départ. Pour Père → colonie en milliers et sans confirmation : /supply." },
  { names: ["deploy"], group: G.generic, usage: "/deploy <de> <vers> <k=n,…>", desc: "déploie des vaisseaux vers une planète à toi",
    detail: "Mission deploy après confirmation ✅. Ex. : /deploy pere fils cruiser=10,largeCargo=5. Sert aussi à ramener une flotte restée à l'abri après un fleet-save." },
  { names: ["spy"], group: G.generic, usage: "/spy <de> <sys:pos> [n]", desc: "espionnage avec n sondes (1 par défaut)",
    detail: "Envoie n sondes (1 par défaut) depuis la planète donnée, après confirmation ✅. Pour sonder toutes les planètes d'un joueur d'un coup : /scan." },
  { names: ["build"], group: G.generic, usage: "/build <planète> <clé>", desc: "lance un bâtiment (confirmation)",
    detail: "Lance l'amélioration d'un bâtiment (clé API, ex. metalMine) après confirmation ✅. Pour l'enchaîner quand la file se libère : /next. Les clés se lisent dans /batiments <planète>." },
  { names: ["research"], group: G.generic, usage: "/research <planète> <clé>", desc: "lance une recherche (confirmation)",
    detail: "Lance une recherche depuis le labo de la planète, après confirmation ✅. Pour la mettre en attente : /next <planète> labo." },
  { names: ["ships"], group: G.generic, usage: "/ships <planète> <clé> <qté>", desc: "construit des vaisseaux / défenses",
    detail: "Met en production <qté> vaisseaux (ou défenses) de la clé donnée au chantier de la planète, après confirmation ✅. Ex. : /ships pere cruiser 10." },
  { names: ["efficiency"], group: G.generic, usage: "/efficiency <planète> <clé> <%>", desc: "règle l'efficacité d'un bâtiment",
    detail: "Règle le pourcentage d'efficacité d'un bâtiment de la planète (endpoint /efficiency du jeu), après confirmation ✅. Ex. : /efficiency pere metalMine 80." },
  { names: ["cancel"], group: G.generic, usage: "/cancel build|ships|research <pl>", desc: "annule une file (confirmation)",
    detail: "Annule la construction en cours (build), la file chantier (ships) d'une planète, ou la recherche en cours (research), après confirmation ✅." },
];

const byName = new Map(TIPS.flatMap((t) => t.names.map((n) => [n, t] as const)));
/** « /P1@monbot », « pirates », « /Scan_Thomas » → nom nu en minuscules. */
const norm = (q: string) => q.trim().toLowerCase().replace(/^\/+/, "").replace(/@.*$/, "");
const detailOf = (t: Tip) => typeof t.detail === "function" ? t.detail() : t.detail;

/** Fiche d'une commande (alias, /xxx, casse libre, scan_<joueur> acceptés) ; inconnue → Error avec des suggestions. */
export function tipFor(q: string): string {
  const n = norm(q);
  const scanName = n.startsWith("scan_") ? q.trim().replace(/^\/+/, "").replace(/@.*$/, "").slice(5) : "";
  const t = byName.get(n) ?? (scanName ? byName.get("scan") : undefined);
  if (!t) {
    const sug = n ? [...byName.keys()].filter((k) => k.includes(n)) : [];
    throw new Error(`Commande inconnue : ${q.trim() || "?"}` + (sug.length ? `\nTu voulais dire : ${sug.map((k) => `/${k}`).join(" · ")} ?` : "") + `\n/tips pour la liste`);
  }
  const alias = t.names.filter((x) => x !== t.names[0]).map((x) => `/${x}`);
  return [
    `${t.usage}${scanName ? `\n(ici : scan de ${scanName})` : ""}`,
    t.desc.charAt(0).toUpperCase() + t.desc.slice(1) + ".",
    ...(detailOf(t) ? ["", detailOf(t)!] : []),
    ...(alias.length ? ["", `Alias : ${alias.join(" · ")}`] : []),
  ].join("\n");
}

/** Index court : un titre par groupe, une ligne par commande, rappel de /tips <commande> en dernière ligne. */
export function tipsIndex(): string {
  const groups = [...new Set(TIPS.map((t) => t.group))];
  return [
    "📖 COMMANDES (Père = point de départ)",
    ...groups.flatMap((g) => ["", g, ...TIPS.filter((t) => t.group === g).map((t) => `${t.usage} — ${t.desc}`)]),
    "",
    "ℹ️ /tips <commande> — le détail (ex. /tips pirates, /tips p1)",
  ].join("\n");
}
