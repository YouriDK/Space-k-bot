// Point d'entrée serveur (Note 9) : lance watch() + commandes Telegram + notifications.
//   npx tsx --env-file=.env telegram.ts
// Long polling getUpdates (aucun port ouvert). Seul TG_CHAT_ID est obéi ; si vide, le bot
// répond à tout message avec le chat id et n'exécute rien.
// Toute commande d'action passe par une confirmation ✅/❌ (sauf recall et flags, urgents).
import {
  api, prepareFleet, sendFleet, parseCoords, getState, watch, setNotify,
  getFlags, setFlag, pause, resume, getHealth, flagsStr, statusSummary, planetsSummary, fleetsSummary, threatsSummary, shipsSummary,
  CARGO, DEUT_RESERVE, PERE, fleetResultStr, log, planetOrThrow, type FleetPlan, type FleetResult, type Flags,
} from "./bot.ts";
import { PRESETS, planPreset, presetsHelp } from "./presets.ts";
import { findPlayer, playerSummary, planScan, runScan } from "./scan.ts";
import { planExpedition, EXPLO_DEUT_KEEP } from "./expedition.ts";
import { piratesSummary } from "./pirates.ts";
import { buildingsSummary, planSummary, setPlanetEnabled, planetPlan, loadPlan, BUILDING_KEYS } from "./autobuild.ts";
import { MISSIONS, type Mission, type Res, type State } from "./spacek-client.ts";

const TOKEN = process.env.TG_TOKEN ?? "";
const CHAT_ID = (process.env.TG_CHAT_ID ?? "").trim();
const HEARTBEAT_MS = (Number(process.env.HEARTBEAT_H) || 6) * 3_600_000;
const CONFIRM_TTL_MS = 60_000;
if (!TOKEN) { console.error("TG_TOKEN manquant dans .env"); process.exit(1); }
const TG = `https://api.telegram.org/bot${TOKEN}`;

// ---------- Transport Telegram ----------
async function tg<T = any>(method: string, params: object): Promise<T> {
  const r = await fetch(`${TG}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) });
  const j: any = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${method} ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.result;
}

// File d'envoi : 1 message/s, découpage > 4000 caractères
const queue: { chatId: string; text: string; extra?: object }[] = [];
function send(text: string, chatId = CHAT_ID, extra?: object) {
  if (!text) return queue.push({ chatId, text: "(vide)" });
  // Découpage > 4000 caractères sur une fin de ligne (pas au milieu d'un mot)
  let rest = text, first = true;
  while (rest.length) {
    let cut = rest.length <= 4000 ? rest.length : rest.lastIndexOf("\n", 4000);
    if (cut <= 0) cut = 4000;
    queue.push({ chatId, text: rest.slice(0, cut), extra: first ? extra : undefined });
    rest = rest.slice(cut).replace(/^\n+/, ""); first = false;
  }
}
(async function sender() {
  for (;;) {
    const m = queue.shift();
    if (m) { try { await tg("sendMessage", { chat_id: m.chatId, text: m.text, ...m.extra }); } catch (e: any) { log("TG send KO", e.message); } }
    await new Promise((r) => setTimeout(r, m ? 1_000 : 200));
  }
})();

// ---------- Confirmations ----------
type Pending = { summary: string; run: () => Promise<any>; expires: number; chatId: string };
const pending = new Map<string, Pending>();
let pendingSeq = 0;
function askConfirm(summary: string, run: () => Promise<any>, chatId: string) {
  const id = String(++pendingSeq);
  pending.set(id, { summary, run, expires: Date.now() + CONFIRM_TTL_MS, chatId });
  send(`⚠️ Confirmer ?\n${summary}\n(expire dans ${CONFIRM_TTL_MS / 1000} s)`, chatId, {
    reply_markup: { inline_keyboard: [[{ text: "✅ Confirmer", callback_data: `ok:${id}` }, { text: "❌ Annuler", callback_data: `no:${id}` }]] },
  });
}
async function onCallback(cq: any) {
  const [verb, id] = String(cq.data ?? "").split(":");
  const chatId = String(cq.message?.chat?.id ?? "");
  const p = pending.get(id);
  const done = (text: string) => tg("answerCallbackQuery", { callback_query_id: cq.id, text: text.slice(0, 200) }).catch(() => {});
  if (chatId !== CHAT_ID) return done("Non autorisé");
  if (cq.message) tg("editMessageReplyMarkup", { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  if (!p) return done("Demande inconnue ou déjà traitée");
  pending.delete(id);
  if (verb !== "ok") { send("❌ Annulé", chatId); return done("Annulé"); }
  if (Date.now() > p.expires) { send("⏱ Expiré, relance la commande", chatId); return done("Expiré"); }
  await done("Exécution…");
  try { send(`✅ OK\n${p.summary}\n→ ${short(await p.run())}`, chatId); }
  catch (e: any) { send(`❌ Échec : ${e.message}`, chatId); }
}
/** Résumé d'une réponse d'action : un POST réussi renvoie l'ÉTAT COMPLET, qu'on ne montre jamais. */
const short = (x: any): string => {
  if (x == null) return "✅ fait";
  if (typeof x === "string") return x.slice(0, 500);
  if (typeof x === "object") {
    if (x.error) return `❌ ${String(x.error).slice(0, 300)}`;
    if (x.state && ("fleetId" in x || "ships" in x)) return fleetResultStr(x as FleetResult); // envoi de flotte
    if (x.planets || x.player) return "✅ pris en compte";                                     // réponse = état complet
  }
  return JSON.stringify(x).slice(0, 400);
};

// ---------- Parsing ----------
const parseShips = (s: string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const part of s.split(",")) {
    const m = part.trim().match(/^([A-Za-z]+)[=:x](\d+)$/);
    if (!m) throw new Error(`Vaisseaux invalides : « ${part} » (attendu k=n,k=n — ex. cruiser=7,largeCargo=10)`);
    out[m[1]] = +m[2];
  }
  return out;
};
const parseKv = (toks: string[]) => {
  const kv: Record<string, number> = {};
  for (const t of toks) { const m = t.match(/^(m|c|d|speed|metal|crystal|deut|deuterium)=(\d+)$/i); if (!m) throw new Error(`Option inconnue : ${t}`); kv[m[1].toLowerCase()] = +m[2]; }
  const cargo: Partial<Res> = {};
  const m = kv.m ?? kv.metal, c = kv.c ?? kv.crystal, d = kv.d ?? kv.deut ?? kv.deuterium;
  if (m != null) cargo.metal = m; if (c != null) cargo.crystal = c; if (d != null) cargo.deuterium = d; // pas d'undefined qui écraserait le défaut 0
  return { cargo, speedPercent: kv.speed };
};
/** Quantités « humaines » : 40 → 40 000 (milliers), 40k → 40 000, 1m → 1 000 000, 250000 → tel quel (≥ 1000). */
const parseK = (x: string): number => {
  const m = x.toLowerCase().match(/^(\d+(?:[.,]\d+)?)([km])?$/);
  if (!m) throw new Error(`Quantité invalide : ${x} (ex. 40, 40k, 1m)`);
  const n = Number(m[1].replace(",", "."));
  return Math.floor(m[2] === "m" ? n * 1_000_000 : m[2] === "k" || n < 1000 ? n * 1000 : n);
};
/** Ravitaillement depuis Père : plafonné aux stocks de Père (garde DEUT_RESERVE) et à la place libre sur la cible.
 *  PT d'abord (plus rapides : 22 000 vs 14 250), dans une flotte À PART ; le reste en GT dans une 2e flotte
 *  (dans une même flotte tout vole à la vitesse du plus lent). Un seul slot libre → envoi mixte avec avertissement. */
function planSupply(s: State, to: string, want: Res): { plans: FleetPlan[]; notes: string[] } {
  const pere = planetOrThrow(s, PERE);
  const dest = planetOrThrow(s, to);
  if (dest.id === pere.id) throw new Error("Père est déjà la source");
  const notes: string[] = [];
  // Pas de plafond côté destination (décision utilisateur) : on envoie ce qui est demandé, dans la limite du stock de Père.
  const cap = (k: keyof Res, avail: number) => {
    const v = Math.min(want[k], Math.max(0, Math.floor(avail)));
    if (v < want[k]) notes.push(`${k} limité au stock de Père (${v.toLocaleString("fr-FR")})`);
    return v;
  };
  let left: Res = { metal: cap("metal", pere.resources.metal), crystal: cap("crystal", pere.resources.crystal), deuterium: cap("deuterium", pere.resources.deuterium - DEUT_RESERVE) };
  const total = left.metal + left.crystal + left.deuterium;
  if (total <= 0) throw new Error("Rien à envoyer (stocks de Père insuffisants)");
  const freeSlots = s.fleetSlots.total - s.fleetSlots.used;
  const pt = pere.ships.smallCargo ?? 0, gt = pere.ships.largeCargo ?? 0;
  const take = (r: Res, capa: number): Res => { // remplit une soute dans l'ordre deut > cristal > métal
    const d = Math.min(r.deuterium, capa); capa -= d; const c = Math.min(r.crystal, capa); capa -= c; const m = Math.min(r.metal, capa);
    return { metal: m, crystal: c, deuterium: d };
  };
  const minus = (a: Res, b: Res): Res => ({ metal: a.metal - b.metal, crystal: a.crystal - b.crystal, deuterium: a.deuterium - b.deuterium });
  const plans: FleetPlan[] = [];
  const nPt = Math.min(pt, Math.ceil(total / CARGO.smallCargo));
  const nGtAll = Math.min(gt, Math.ceil(Math.max(0, total - nPt * CARGO.smallCargo) / CARGO.largeCargo));
  if (nPt && nGtAll && freeSlots < 2) {
    // un seul slot : flotte mixte (vole à la vitesse des GT)
    notes.push("⚠️ un seul slot libre : PT + GT dans la même flotte, à la vitesse des GT");
    const ships = { smallCargo: nPt, largeCargo: nGtAll };
    plans.push(prepareFleet(s, { from: PERE, mission: "transport", coords: dest.coords, ships, cargo: take(left, nPt * CARGO.smallCargo + nGtAll * CARGO.largeCargo), label: "📦 Ravitaillement (mixte)" }));
  } else {
    if (nPt) {
      const cargo = take(left, nPt * CARGO.smallCargo); left = minus(left, cargo);
      plans.push(prepareFleet(s, { from: PERE, mission: "transport", coords: dest.coords, ships: { smallCargo: nPt }, cargo, label: "📦 Ravitaillement — PT (rapides)" }));
    }
    const rest = left.metal + left.crystal + left.deuterium;
    if (rest > 0) {
      const nGt = Math.min(gt, Math.ceil(rest / CARGO.largeCargo));
      if (!nGt) notes.push(`⚠️ il reste ${rest.toLocaleString("fr-FR")} sans transporteur disponible`);
      else {
        const cargo = take(left, nGt * CARGO.largeCargo); left = minus(left, cargo);
        plans.push(prepareFleet(s, { from: PERE, mission: "transport", coords: dest.coords, ships: { largeCargo: nGt }, cargo, label: "📦 Ravitaillement — GT (complément)", slotsReserved: plans.length }));
        const still = left.metal + left.crystal + left.deuterium;
        if (still > 0) notes.push(`⚠️ soute insuffisante : ${still.toLocaleString("fr-FR")} non envoyés`);
      }
    }
  }
  if (!plans.length) throw new Error("Aucun transporteur sur Père");
  return { plans, notes };
}
const coordsOf = (s: State, q: string) => { try { return planetOrThrow(s, q).coords; } catch { return parseCoords(q); } };
const need = (toks: string[], n: number, usage: string) => { if (toks.length < n) throw new Error(`Usage : ${usage}`); };

// ---------- Commandes ----------
// Commandes courtes (les tiennes) — attaques, scans et expéditions partent toujours de Père
const helpText = () => `📖 COMMANDES SPACE-K BOT
Toutes les attaques, scans, expéditions et ravitaillements partent de Père.
<planète> = pere · fils · oncle · cousin · bl (ou id pl_xx, ou coords 6:7)

━━━━━━━━━━━━━━━━━━━━
👁 LECTURE
━━━━━━━━━━━━━━━━━━━━
/status — ressources, slots, flottes, menaces, latence
/flotte — mes vaisseaux par planète + flottes en vol
/threats — menaces en approche
/pirates — caches pirates T0/T1/T2 connues, avec le preset conseillé
/joueur <nom> — planètes, rang et puissance d'un joueur
/plan — auto-construction : planètes actives, palier, prochain bâtiment
/batiments <planète> — les 12 bâtiments : niveau, coût, durée
/flags — état des automatismes

━━━━━━━━━━━━━━━━━━━━
⚔️ RAIDS (récap + ✅ Confirmer / ❌ Annuler)
━━━━━━━━━━━━━━━━━━━━
Attendre l'allié ✔ toujours coché. La cible doit exister dans la galaxie et ne pas être à toi.
Ex. : /p0 under 12:9

${presetsHelp()}

━━━━━━━━━━━━━━━━━━━━
🔍 SCANS (immédiats, ${process.env.SCAN_PROBES || 15} sondes par planète)
━━━━━━━━━━━━━━━━━━━━
/scan_2003CP0 · /scan_987 · /scan_Thomas · /scan_aaa
/scan <nom> — n'importe quel joueur
Pas assez de sondes → réparties à parts égales. Récap ✅ par planète.

━━━━━━━━━━━━━━━━━━━━
🧭 EXPÉDITIONS (6:16, récap + ✅)
━━━━━━━━━━━━━━━━━━━━
/explo opti <h> — 10 éclaireurs + 100 GT, durée <h>
/explo 911 [h] — tous éclaireurs + GT + VB + croiseurs, toutes les ressources, garde ${EXPLO_DEUT_KEEP.toLocaleString("fr-FR")} deut (2 h par défaut)
Refus clair si limite 24 h, simultané ou système saturé.

━━━━━━━━━━━━━━━━━━━━
📦 RAVITAILLEMENT (immédiat)
━━━━━━━━━━━━━━━━━━━━
/supply <planète> <métal> <cristal> <deut> — en milliers
Ex. : /supply fils 40 14 90 → 40 000 M, 14 000 C, 90 000 D
PT d'abord (rapides), GT en complément dans une 2e flotte.

━━━━━━━━━━━━━━━━━━━━
🏗 AUTO-CONSTRUCTION (par planète)
━━━━━━━━━━━━━━━━━━━━
/autobuild <planète> on — active la planète
/autobuild <planète> off — désactive
/autobuild <planète> — état
/autobuild off — désactive toutes les planètes
Paliers 5 → 7 → 9 → 10 puis +1, ordre : robots > chantier > labo > solaire > fusion > cristal > deut > métal > silo > hangars. Pas les sous ou énergie négative → suivant. 2 min de délai après chaque fin.

━━━━━━━━━━━━━━━━━━━━
🛡 DÉFENSE AUTO
━━━━━━━━━━━━━━━━━━━━
/save on — arme le fleet-save : 10 s avant une sonde ou une attaque, toute la flotte + ressources décollent vers la planète voisine, rappel juste après
/save off — mode observation (« j'AURAIS décollé »)
/collect on|off — vide les colonies qui débordent vers Père
/recall <fleetId> — rappelle une flotte (immédiat)
/pause — coupe tous les automatismes · /resume — les restaure

━━━━━━━━━━━━━━━━━━━━
🔧 DIVERS
━━━━━━━━━━━━━━━━━━━━
/token <refresh_token> — renouvelle le token Keycloak (tous les 7 j max)
/help full — commandes génériques (/send, /transport, /deploy, /spy, /build, /research, /ships, /cancel, /efficiency)

🔔 Notifications automatiques : 🏴‍☠️ nouvelle cache pirate (T0→/p0, T1→/p1, T2→/p2) · bâtiment / recherche / chantier terminés · sondé par X · sonde ou attaque en approche · impact · erreurs · heartbeat toutes les ${process.env.HEARTBEAT_H || 6} h`;

const HELP_FULL = `Lecture
/status · /planets · /fleets · /threats · /presets · /flags · /flotte · /joueur <nom> · /plan · /batiments <planète>

Actions (confirmation ✅/❌)
/p0 · /p1 · /p2 <variante> <sys:pos>   (variantes : ${Object.entries(PRESETS).map(([g, v]) => `${g}: ${Object.keys(v).join("|")}`).join(" · ")})
/scan_<joueur> · /scan <joueur>
/explo opti <h> · /explo 911 [h]
/send <planète> <mission> <sys:pos|planète> <k=n,k=n> [m=… c=… d=… speed=…]
/transport <de> <vers> <metal> <crystal> <deut>
/deploy <de> <vers> <k=n,k=n>
/spy <de> <sys:pos> [nbSondes]
/build <planète> <key> · /research <planète> <key> · /ships <planète> <key> <qty>
/cancel build|ships|research <planète> · /efficiency <planète> <key> <percent>

Immédiat
/recall <fleetId> · /token <refresh_token>
/save on|off · /collect on|off · /autobuild <planète> on|off · /pause · /resume

<planète> = nom (Père), id (pl_2w) ou coords (6:4). Bâtiments : ${BUILDING_KEYS.join(", ")}`;

async function handle(text: string, chatId: string) {
  const [cmdRaw, ...args] = text.trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@.*$/, "");
  const withState = async <T>(fn: (s: State) => T) => fn(await getState());
  const fleetAction = (plan: FleetPlan) => askConfirm(plan.summary, () => sendFleet(plan), chatId);
  const simple = (summary: string, run: () => Promise<any>) => askConfirm(summary, run, chatId);
  const planet = planetOrThrow;
  // Scans : immédiats, sans confirmation (décision utilisateur) ; récap ✅ par planète une fois parti
  const scanPlayer = async (q: string, chat: string) => {
    send(`🔭 Recherche des planètes de ${q}…`, chat);
    const sc = await planScan(await getState(), q);
    return send(`🔍 Scan de ${sc.player.name} lancé :\n${await runScan(sc)}`, chat);
  };

  switch (cmd) {
    case "/help": case "/start": return send(args[0] === "full" ? HELP_FULL : helpText(), chatId);
    case "/flotte": case "/flottes": return send(await withState(shipsSummary), chatId);
    case "/joueur": case "/player": {
      need(args, 1, "/joueur <nom>");
      const q = args.join(" ");
      send(`🔭 Recherche de ${q}…`, chatId);
      return send(playerSummary(await findPlayer(q), q), chatId);
    }
    case "/p0": case "/p1": {
      // /p0 under 12:9 · /p1 opti_over 12:9 — toujours depuis Père, rallier ✔, cible vérifiée dans la galaxie
      need(args, 2, `${cmd} <${Object.keys(PRESETS[cmd.slice(1)]).join("|")}> <sys:pos>`);
      const s = await getState();
      return fleetAction(await planPreset(s, cmd.slice(1), args[0], args[1]));
    }
    case "/scan": {
      need(args, 1, "/scan <joueur>");
      return scanPlayer(args.join(" "), chatId);
    }
    case "/explo": {
      need(args, 1, "/explo opti <h> | /explo 911 [h]");
      const kind = args[0].toLowerCase();
      if (kind !== "opti" && kind !== "911") throw new Error("Usage : /explo opti <h> | /explo 911 [h]");
      const h = args[1] != null ? Number(args[1]) : undefined;
      if (args[1] != null && !Number.isFinite(h)) throw new Error(`Durée invalide : ${args[1]}`);
      return fleetAction(await withState((s) => planExpedition(s, kind, h)));
    }
    case "/plan": return send(await withState(planSummary), chatId);
    case "/batiments": case "/buildings": { need(args, 1, "/batiments <planète>"); return send(await withState((s) => buildingsSummary(planet(s, args[0]))), chatId); }
    case "/autobuild": {
      // /autobuild <planète…> on|off · /autobuild <planète…> (état) · /autobuild off (désactive toutes les planètes). Pas d'interrupteur global.
      need(args, 1, "/autobuild <planète> on|off");
      const isOnOff = (x: string) => /^(on|off|1|0|true|false)$/i.test(x);
      const asBool = (x: string) => /^(on|1|true)$/i.test(x);
      const s = await getState();
      if (args.length === 1 && isOnOff(args[0])) {
        if (asBool(args[0])) return send("L'auto-construction s'active par planète : /autobuild cousin on, /autobuild bl on…\n\n" + planSummary(s), chatId);
        for (const p of s.planets) setPlanetEnabled(p.id, false, s);
        return send("Auto-construction désactivée sur toutes les planètes.\n\n" + planSummary(s), chatId);
      }
      const last = args[args.length - 1];
      const nameParts = isOnOff(last) ? args.slice(0, -1) : args;
      const p = planet(s, nameParts.join(" "));
      if (isOnOff(last)) setPlanetEnabled(p.id, asBool(last), s);
      const on = planetPlan(loadPlan(s), p.id).enabled;
      return send(`Auto-construction ${p.name} : ${on ? "ON ✅" : "off"}${on && !getFlags().autobuild ? " (⏸ tout est en pause → /resume)" : ""}\n\n${planSummary(s)}`, chatId);
    }
    case "/status": return send(await withState(statusSummary), chatId);
    case "/planets": return send(await withState(planetsSummary), chatId);
    case "/fleets": return send(await withState(fleetsSummary), chatId);
    case "/threats": return send(await withState(threatsSummary), chatId);
    case "/pirates": return send(await withState(piratesSummary), chatId);
    case "/presets": return send(presetsHelp(), chatId);
    case "/flags": return send(flagsStr(getFlags()), chatId);

    case "/supply": {
      // /supply fils 40 14 90 → 40 000 métal, 14 000 cristal, 90 000 deut depuis Père (PT puis GT), part immédiatement
      need(args, 4, "/supply <planète> <métal> <cristal> <deut>  (en milliers : 40 = 40 000 ; accepte 40k, 1m)");
      const [to, m, c, d] = args;
      const { plans, notes } = await withState((s) => planSupply(s, to, { metal: parseK(m), crystal: parseK(c), deuterium: parseK(d) }));
      const out: string[] = [];
      for (const plan of plans) {
        try { await sendFleet(plan); out.push(`✅ ${plan.summary}`); }
        catch (e: any) { out.push(`❌ ${plan.summary}\n${e.message.slice(0, 150)}`); }
      }
      return send([...out, ...notes].join("\n\n"), chatId);
    }
    case "/save": case "/supply_auto": case "/collect": {
      need(args, 1, `${cmd} on|off`);
      const v = /^(on|1|true)$/i.test(args[0]);
      const key = (cmd === "/supply_auto" ? "supply" : cmd.slice(1)) as keyof Flags;
      const f = setFlag(key, v);
      return send(`${key === "save" && v ? "🔴 FLEET-SAVE ARMÉ" : ""}\n${flagsStr(f)}`.trim(), chatId);
    }
    case "/pause": return send(`⏸ Pause\n${flagsStr(pause())}`, chatId);
    case "/resume": return send(`▶️ Reprise\n${flagsStr(resume())}`, chatId);
    case "/token": {
      // Renouvellement du refresh token Keycloak depuis Telegram (pas besoin de ssh). Testé immédiatement.
      need(args, 1, "/token <refresh_token>");
      await api.setRefreshToken(args[0]);
      return send("🔑 Refresh token remplacé et auth re-testée : OK ✅", chatId);
    }
    case "/recall": { need(args, 1, "/recall <fleetId>"); await api.recall(args[0]); return send(`✅ Rappel demandé pour la flotte ${args[0]}`, chatId); }

    case "/send": {
      need(args, 4, "/send <planète> <mission> <sys:pos> <k=n,k=n> [m= c= d= speed=]");
      const [from, mission, to, ships, ...rest] = args;
      if (!MISSIONS.includes(mission as Mission)) throw new Error(`Mission inconnue : ${mission} (${MISSIONS.join(", ")})`);
      const { cargo, speedPercent } = parseKv(rest);
      return fleetAction(await withState((s) => prepareFleet(s, { from, mission: mission as Mission, coords: coordsOf(s, to), ships: parseShips(ships), cargo, speedPercent })));
    }
    case "/transport": {
      need(args, 5, "/transport <de> <vers> <metal> <crystal> <deut>");
      const [from, to, m, c, d] = args;
      return fleetAction(await withState((s) => {
        const p = planet(s, from);
        const cargo: Res = { metal: +m || 0, crystal: +c || 0, deuterium: +d || 0 };
        const total = cargo.metal + cargo.crystal + cargo.deuterium;
        // GT d'abord, PT en complément, selon ce qu'il y a sur place
        const lc = Math.min(p.ships.largeCargo ?? 0, Math.ceil(total / CARGO.largeCargo));
        const rest = Math.max(0, total - lc * CARGO.largeCargo);
        const sc = Math.min(p.ships.smallCargo ?? 0, Math.ceil(rest / CARGO.smallCargo));
        const ships: Record<string, number> = {}; if (lc) ships.largeCargo = lc; if (sc) ships.smallCargo = sc;
        return prepareFleet(s, { from, mission: "transport", coords: coordsOf(s, to), ships, cargo });
      }));
    }
    case "/deploy": {
      need(args, 3, "/deploy <de> <vers> <k=n,k=n>");
      const [from, to, ships] = args;
      return fleetAction(await withState((s) => prepareFleet(s, { from, mission: "deploy", coords: coordsOf(s, to), ships: parseShips(ships) })));
    }
    case "/spy": {
      need(args, 2, "/spy <de> <sys:pos> [n]");
      return fleetAction(await withState((s) => prepareFleet(s, { from: args[0], mission: "espionage", coords: parseCoords(args[1]), ships: { espionageProbe: +(args[2] ?? 1) } })));
    }

    case "/build": { need(args, 2, "/build <planète> <key>"); const p = await withState((s) => planet(s, args[0])); return simple(`build ${args[1]} sur ${p.name}`, () => api.build(p.id, args[1])); }
    case "/research": { need(args, 2, "/research <planète> <key>"); const p = await withState((s) => planet(s, args[0])); return simple(`research ${args[1]} depuis ${p.name}`, () => api.research(p.id, args[1])); }
    case "/ships": { need(args, 3, "/ships <planète> <key> <qty>"); const p = await withState((s) => planet(s, args[0])); return simple(`${args[2]} × ${args[1]} sur ${p.name}`, () => api.ships(p.id, args[1], +args[2])); }
    case "/efficiency": { need(args, 3, "/efficiency <planète> <key> <percent>"); const p = await withState((s) => planet(s, args[0])); return simple(`${args[1]} à ${args[2]} % sur ${p.name}`, () => api.setEfficiency(p.id, args[1], +args[2])); }
    case "/cancel": {
      need(args, 2, "/cancel build|ships|research <planète>");
      const p = await withState((s) => planet(s, args[1]));
      const what = args[0].toLowerCase();
      if (what === "build") return simple(`annuler la construction sur ${p.name}`, () => api.cancelBuild(p.id));
      if (what === "ships") return simple(`annuler la file chantier sur ${p.name}`, () => api.cancelShips(p.id));
      if (what === "research") return simple(`annuler la recherche en cours`, () => api.cancelResearch());
      throw new Error("Usage : /cancel build|ships|research <planète>");
    }
    default:
      if (cmd.startsWith("/scan_")) return scanPlayer(cmdRaw.replace(/@.*$/, "").slice(6), chatId); // /scan_2003CP0 (casse d'origine)
      return send(`Commande inconnue : ${cmd}\n/help pour la liste`, chatId);
  }
}

// ---------- Boucle getUpdates ----------
async function poll() {
  let offset = 0;
  for (;;) {
    try {
      const updates: any[] = await tg("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] });
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.callback_query) { await onCallback(u.callback_query); continue; }
        const msg = u.message; if (!msg?.text) continue;
        const chatId = String(msg.chat.id);
        if (!CHAT_ID) { log("chat id reçu :", chatId, "(mets TG_CHAT_ID dans .env)"); send(`Ton chat id est ${chatId} — mets TG_CHAT_ID=${chatId} dans .env et relance.`, chatId); continue; }
        if (chatId !== CHAT_ID) continue; // silence pour les inconnus
        log("TG <", msg.text.startsWith("/token") ? "/token <masqué>" : msg.text);
        await handle(msg.text, chatId).catch((e: any) => send(`❌ ${e.message}`, chatId));
      }
    } catch (e: any) { log("TG poll KO", e.message); await new Promise((r) => setTimeout(r, 5_000)); }
  }
}

// ---------- Heartbeat / watchdog ----------
function heartbeat() {
  let stalled = false;
  setInterval(() => {
    const h = getHealth();
    send(`💓 vivant · uptime ${Math.round(h.uptimeMs / 3_600_000)} h · latence ${h.avgLatencyMs} ms · ${h.polls} polls · ${h.errors} erreurs · dernier poll il y a ${h.lastPollAt ? Math.round((Date.now() - h.lastPollAt) / 1000) : "∞"} s\n${flagsStr(getFlags())}`);
  }, HEARTBEAT_MS);
  setInterval(() => {
    const h = getHealth();
    const since = Date.now() - (h.lastPollAt || h.startedAt);
    if (since > 120_000 && !stalled) { stalled = true; send(`🚨 Aucun poll /state réussi depuis ${Math.round(since / 1000)} s — dernière erreur : ${h.lastError || "?"}`); }
    if (since <= 120_000 && stalled) { stalled = false; send("✅ Poll /state rétabli"); }
  }, 30_000);
}

// ---------- Démarrage ----------
if (CHAT_ID) {
  setNotify((m) => send(m));
  send(`🚀 spacek-bot démarré\n${flagsStr(getFlags())}\n/help pour les commandes`);
  heartbeat();
  watch();
} else {
  log("TG_CHAT_ID vide : écris au bot pour obtenir ton chat id. watch() non lancé.");
}
poll();
