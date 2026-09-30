// /tips : index « clean » des commandes (une ligne chacune) et fiche détaillée par commande (/tips pirates, /tips p1, /tips autosupply…).
// Registre unique : toute commande du switch de telegram.ts doit y figurer (aliases compris). Les détails lisent les valeurs vivantes
// (PRESETS, cible de ravitaillement, garde deut des expéditions…) plutôt que de les recopier. Aucun import de telegram.ts / bot.ts (pas de cycle).
import { MISSIONS } from "./spacek-client.ts";
import { PRESETS, presetGroupHelp } from "./presets.ts";
import { SUPPLY_EVERY_H, supplyTargetStr } from "./supply.ts";
import { EXPLO_AUTO_HOURS, EXPLO_DEUT_KEEP, EXPLO_911_HOURS } from "./expedition.ts";
import { OBJECTIFS } from "./autobuild.ts";
import { DEUT_RESERVE, num } from "./core.ts";

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
    detail: "save (armé / observation), ravitaillement auto, collect, recyclage, récupération, expédition auto, autobuild. Se règle avec /save, /collect, /recycle, /recup, /autoexplo, /autosupply, /autobuild, /pause." },
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
  { names: ["autoexplo", "explo_auto"], group: G.scans, usage: "/autoexplo [on|off]", desc: "toujours une expédition en vol",
    detail: () => [
      `Garde en permanence UNE expédition en vol : 10 éclaireurs + 100 GT depuis Père vers la position 16, ${EXPLO_AUTO_HOURS} h à chaque fois (EXPLO_AUTO_HOURS). La suivante part dès que la précédente est entièrement rentrée. Désactivé par défaut.`,
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
  { names: ["plan"], group: G.build, usage: "/plan", desc: "auto-construction : état et prochain bâtiment",
    detail: "Planètes où /autobuild est actif, objectifs, règles (réservoir plein, énergie), et pour chaque planète le prochain bâtiment choisi avec son coût, sa durée et la raison, ou les bâtiments sautés." },
  { names: ["batiments", "buildings"], group: G.build, usage: "/batiments <planète>", desc: "bâtiments : niveau, coût, durée",
    detail: "Pour une planète : énergie, champs utilisés, et chaque bâtiment constructible avec niveau actuel → suivant, coût, durée, 🔒 si verrouillé (et ce qui manque). Lecture seule ; pour construire : /build ou /next." },
  { names: ["autobuild"], group: G.build, usage: "/autobuild [<planète>] on|off", desc: "auto-construction par planète",
    detail: () => [
      `Enchaîne les bâtiments d'une planète selon les objectifs : ${OBJECTIFS.map((o) => `${o.key} ${o.max}`).join(" > ")}.`,
      `/autobuild fils on · /autobuild fils off · /autobuild fils (état) · /autobuild off (désactive toutes les planètes)`,
      `Pas les ressources → on passe au suivant. Réservoir plein → on l'agrandit avant la mine. Énergie qui passerait en négatif → centrale d'abord. Délai de quelques minutes après chaque fin.`,
      `Les objectifs se règlent dans build-plan.json (rechargé à chaud). Sans confirmation. /plan montre l'état ; /pause coupe aussi l'auto-construction.`,
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
    detail: "Coupe save, collect, recyclage, récupération, expédition auto, auto-construction et auto-ravitaillement. Les activations par planète (/autobuild, /autosupply) et leurs échéances sont conservées. /resume restaure l'état d'avant." },
  { names: ["resume"], group: G.auto, usage: "/resume", desc: "restaure les automatismes",
    detail: "Remet les automatismes dans l'état où ils étaient avant /pause." },

  // ---- Divers
  { names: ["help", "start"], group: G.divers, usage: "/help [full]", desc: "aide détaillée (full : commandes génériques)",
    detail: "L'aide longue, par sections. /help full : la liste compacte avec les commandes génériques. Pour une vue courte : /tips." },
  { names: ["tips", "tip"], group: G.divers, usage: "/tips [<commande>]", desc: "cette liste · le détail d'une commande",
    detail: "/tips — l'index court de toutes les commandes (une ligne chacune). /tips <commande> — la fiche : ce que ça fait, arguments, exemples, confirmation ou non. Accepte /pirates, p1, autosupply, scan_Thomas… Seul le premier mot est pris en compte." },
  { names: ["token"], group: G.divers, usage: "/token <refresh_token>", desc: "renouvelle le token Keycloak",
    detail: "Remplace le refresh token Keycloak et re-teste l'authentification tout de suite. Le jeton se renouvelle tout seul tant que le bot tourne ; il n'expire qu'après 7 jours d'inactivité. Le message n'est pas journalisé en clair." },

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
