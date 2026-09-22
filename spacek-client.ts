// Space-K API client — auth Keycloak → Kaiya → Space-K + endpoints relevés le 21/09/2026.
// Voir space-k-api.md pour le statut (TESTÉ / BUNDLE / DÉDUIT) de chaque appel.
// Aucun appel vers /api/dev/* (routes admin) : interdit.
import { appendFileSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const KC = "https://auth.kreactive.fr/realms/PROD-Kaido/protocol/openid-connect/token";
const TICKET = "https://kaiya.kreactive.fr/api/custom-apps/space-k/embed-ticket";
const API = "https://space-k.apps.kaiya.kreactive.fr/api";
const POST_SAMPLES = "post-samples.jsonl"; // réponses des POST : inconnues → on les capture

export type Coords = { system: number; position: number };
export type Res = { metal: number; crystal: number; deuterium: number };
export type Mission =
  | "transport" | "attack" | "espionage" | "deploy" | "recycle"
  | "expedition" | "colonize" | "livraison" | "recuperation" | "destroyMoon";
export const MISSIONS: Mission[] = [
  "transport", "attack", "espionage", "deploy", "recycle",
  "expedition", "colonize", "livraison", "recuperation", "destroyMoon",
];

// ---------- Types de /api/state (minimaux : `any` sur les zones jamais observées) ----------
export type Planet = {
  id: string;
  name: string;
  coords: Coords & { galaxy?: number };
  resources: Res;
  capacities: Res;
  production?: Res;
  energy?: any;
  ships: Record<string, number>;
  defences?: Record<string, number>;
  buildQueue?: any;
  shipQueue?: any;
  [k: string]: any;
};
export type Fleet = {
  id: string;
  mission: Mission | string;
  ships: Record<string, number>;
  phase?: string;            // "outbound" observé sur les vols aller [DÉDUIT]
  departsAt?: number;
  arrivesAt?: number;
  returnsAt?: number;
  distance?: number;
  fuel?: number;
  origin?: { planetId?: string; coords?: Coords };
  target?: { coords?: Coords; [k: string]: any };
  [k: string]: any;
};
export type GalaxyPlanet = {
  id: string; name: string; ownerId: string; ownerName: string; temperature: number;
  vacances: boolean; protection: any; expose: boolean; ecart: any; moon: any;
};
export type GalaxyPirate = { nom: string; tier: string; expireA?: number; maitrise?: boolean; boss?: boolean; coque?: number }; // [TESTÉ 21/09 + BUNDLE]
export type GalaxySlot = {
  position: number; astroRequis: number; colonisable: boolean; pirate: GalaxyPirate | null; balise: any; convoi: any; recup: any; contrat: any;
  planet: GalaxyPlanet | null; debris: { metal: number; crystal: number } | null;
};
export type GalaxySystem = { system: number; slots: GalaxySlot[]; occupancy: any; recup: any };
export type LeaderboardRow = {
  id: string; name: string; avatar?: string; titre?: string; combatPower: number; development: number; glory: number; total: number; planets: number;
};
export type State = {
  now: number;               // horloge serveur (ms) — toujours l'utiliser
  player: { research?: Record<string, number>; vitesses?: Record<string, number>; isProtected?: boolean; [k: string]: any };
  planets: Planet[];
  fleets: Fleet[];
  fleetSlots: { used: number; total: number };
  incoming?: any[];          // FORMAT INCONNU (jamais vu non vide)
  menaces?: any[];           // FORMAT INCONNU
  alertesVives?: any[];      // FORMAT INCONNU
  [k: string]: any;
};

/** Trouve une planète par id (`pl_2w`), nom (« Père », insensible à la casse/accents) ou coords (`6:4`). */
export function planetByName(s: State, q: string): Planet | undefined {
  const norm = (x: string) => x.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const n = norm(q);
  const m = n.match(/^(\d+):(\d+)$/);
  if (m) return s.planets.find((p) => p.coords.system === +m[1] && p.coords.position === +m[2]);
  const initials = (name: string) => (name.match(/[A-ZÀ-Ý][a-zà-ÿ]*/g) ?? []).map((w) => norm(w[0])).join(""); // « BetweenLands » → « bl »
  return s.planets.find((p) => p.id.toLowerCase() === n)
    ?? s.planets.find((p) => PLANET_ALIASES[n] === p.id)
    ?? s.planets.find((p) => norm(p.name) === n)
    ?? s.planets.find((p) => norm(p.name).includes(n)) // « pere » ↔ « Planète Père »
    ?? s.planets.find((p) => initials(p.name) === n);  // « bl » ↔ « BetweenLands »
}
/** Raccourcis Telegram → id de planète (à compléter si une planète est renommée / colonisée). */
export const PLANET_ALIASES: Record<string, string> = {
  pere: "pl_2w", fils: "pl_rn", oncle: "pl_402", cousin: "pl_4z8", bl: "pl_7vb", between: "pl_7vb", betweenlands: "pl_7vb",
};

export class SpaceK {
  private session: string | null = null;
  private sessionExp = 0; // secondes epoch
  private ticketLogged = false;
  private minting: Promise<void> | null = null; // verrou : un seul mint à la fois (rotation Keycloak)

  constructor(private refreshFile = process.env.REFRESH_FILE ?? "./refresh_token.txt") {}

  // ---------- Auth ----------
  /** Sauvegarde ATOMIQUE du refresh token (rotation Keycloak) : .bak ← ancien, .tmp → rename. */
  private saveRefresh(token: string) {
    if (existsSync(this.refreshFile)) copyFileSync(this.refreshFile, `${this.refreshFile}.bak`);
    writeFileSync(`${this.refreshFile}.tmp`, token, { mode: 0o600 });
    renameSync(`${this.refreshFile}.tmp`, this.refreshFile);
  }

  // [DÉDUIT] appel vu dans le Network, paramètres lus dans les tokens
  private async kcAccess(): Promise<string> {
    const r = await fetch(KC, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "front-public-client",
        refresh_token: readFileSync(this.refreshFile, "utf8").trim(),
      }),
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 120);
      throw new Error(`🔑 Refresh token refusé par Keycloak (${r.status} ${detail}). Reconnecte-toi sur kaiya.kreactive.fr en fenêtre privée, copie localStorage.refresh_token et envoie-le au bot : /token <valeur>`);
    }
    const j: any = await r.json();
    if (j.refresh_token) this.saveRefresh(j.refresh_token);
    return j.access_token;
  }

  /** Décode le payload du kaiya_session : format inconnu (JWT ? segment 0 ou 1 ?) → on essaie chaque segment. [DÉDUIT] */
  private decodeExp(token: string): number | null {
    for (const seg of token.split(".")) {
      try {
        const p = JSON.parse(Buffer.from(seg, "base64url").toString());
        if (p && typeof p.exp === "number") return p.exp > 1e11 ? Math.floor(p.exp / 1000) : p.exp; // ms ou s
      } catch { /* segment non JSON */ }
    }
    return null;
  }

  private async mint(): Promise<void> {
    const at = await this.kcAccess();
    // [TESTÉ] → 201 { url: ".../__kaiya/session?ticket=…" }
    const tr = await fetch(TICKET, { method: "POST", headers: { Authorization: `Bearer ${at}` } });
    if (!tr.ok) throw new Error(`embed-ticket ${tr.status}: ${(await tr.text()).slice(0, 200)}`);
    const { url } = (await tr.json()) as { url: string };

    // [TESTÉ 21/09/2026] 302 avec Location: /#kaiya_session=<token> ET Set-Cookie: kaiya_app_session=<token>; Max-Age=43200 (12 h).
    const r = await fetch(url, { redirect: "manual" });
    const loc = r.headers.get("location") ?? "";
    const setCookie = r.headers.get("set-cookie") ?? "";
    const body = await r.text();
    if (!this.ticketLogged) {
      this.ticketLogged = true;
      // Jetons masqués : les logs pm2 ne doivent pas contenir de session utilisable
      const mask = (x: string) => x.replace(/(kaiya_session|kaiya_app_session|ticket)=[A-Za-z0-9._-]+/g, "$1=<masqué>");
      console.log(new Date().toISOString(), "[auth] échange ticket → status", r.status,
        "headers", mask(JSON.stringify(Object.fromEntries(r.headers))), "body", mask(body.slice(0, 300).replace(/\s+/g, " ")));
    }
    const m = loc.match(/kaiya_session=([A-Za-z0-9._-]+)/)
      ?? setCookie.match(/kaiya_app_session=([A-Za-z0-9._-]+)/)
      ?? body.match(/kaiya_session[=:"']+([A-Za-z0-9._-]+)/);
    if (!m) throw new Error(`Ticket non échangé (status ${r.status}) — voir le log [auth] pour documenter le mécanisme`);
    this.session = m[1];
    const exp = this.decodeExp(this.session);
    if (exp) this.sessionExp = exp;
    else {
      this.sessionExp = Math.floor(Date.now() / 1000) + 11 * 3600; // ≈ 12 h observées, marge 1 h
      console.warn("[auth] exp du kaiya_session illisible : expiration supposée dans 11 h");
    }
  }

  private async token(): Promise<string> {
    if (!this.session || Date.now() / 1000 > this.sessionExp - 300) {
      // Deux appels concurrents (watch + Telegram) ne doivent pas lancer deux refresh Keycloak
      // avec le même refresh token : le second serait refusé (rotation) → on partage la promesse.
      this.minting ??= this.mint().finally(() => { this.minting = null; });
      await this.minting;
    }
    return this.session!;
  }

  /** Force un nouveau mint au prochain appel (ex. après un 401). */
  invalidate() { this.session = null; }

  /** Remplace le refresh token (ex. via /token sur Telegram) et re-teste immédiatement l'auth. */
  async setRefreshToken(token: string) {
    const t = token.trim();
    if (!/^[A-Za-z0-9._-]{50,}$/.test(t)) throw new Error("Ce n'est pas un refresh token (attendu : une longue chaîne eyJ…)");
    this.saveRefresh(t);
    this.session = null;
    await this.mint(); // lève une erreur claire si le token est refusé
  }

  private async call<T = any>(path: string, body?: object, retry = true): Promise<T> {
    const tok = await this.token();
    const r = await fetch(`${API}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        "x-kaiya-session": tok,                 // [TESTÉ] header + cookie ensemble ; seul ? inconnu
        cookie: `kaiya_app_session=${tok}`,
        ...(body && { "content-type": "application/json" }),
      },
      body: body && JSON.stringify(body),
    });
    if (r.status === 401 && retry) { this.session = null; return this.call(path, body, false); }
    const text = await r.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* 401 = page HTML */ }
    if (body) {
      // [TESTÉ 22/09] un POST réussi renvoie l'ÉTAT COMPLET : on ne garde que les clés (sinon le disque du téléphone se remplit).
      // Les erreurs, elles, sont conservées en entier (c'est là qu'est l'information).
      const resume = r.ok
        ? { ok: true, keys: json && typeof json === "object" ? Object.keys(json).slice(0, 12) : String(json).slice(0, 200) }
        : { ok: false, error: json && typeof json === "object" ? json.error ?? json : String(json).slice(0, 500) };
      try { appendFileSync(POST_SAMPLES, JSON.stringify({ at: Date.now(), path, body, status: r.status, ...resume }) + "\n"); } catch { /* disque plein ? on ignore */ }
    }
    if (!r.ok) throw new Error(`${path} ${r.status}: ${text.slice(0, 200)}`);
    return json as T;
  }

  // ---------- Lecture ----------
  state = () => this.call<State>("/state");                                    // [TESTÉ]
  // [TESTÉ 21/09] { systemes: [{ system, planetes, miennes, pirates, moissonneur, balise, depot, debris, cargaison }] }
  galaxy = () => this.call<{ systemes: { system: number; planetes: number; miennes: number; pirates: number; debris: boolean }[] }>("/galaxy/carte");
  // [TESTÉ 21/09] { system, slots: [{ position, astroRequis, colonisable, pirate, balise, convoi, recup, contrat, planet, debris }], occupancy, recup }
  galaxySystem = (system: number) => this.call<GalaxySystem>(`/galaxy?system=${system}`);
  // [TESTÉ 21/09] { rows: [{ id, name, avatar, titre, combatPower, development, glory, total, planets }], meId }
  leaderboard = () => this.call<{ rows: LeaderboardRow[]; meId: string }>("/leaderboard");
  codex = (planetId: string) => this.call(`/codex?planetId=${encodeURIComponent(planetId)}`); // [BUNDLE]
  // [TESTÉ 21/09] par **id joueur** (UUID du leaderboard), pas par nom → { id, name, development, combatPower, planets (nombre), achievements, titre… }
  profile = (playerId: string) => this.call(`/profile/${encodeURIComponent(playerId)}`);
  config = () => this.call("/config");                                         // [BUNDLE]

  // ---------- Économie [BUNDLE] ----------
  build = (planetId: string, key: string) => this.call("/build", { planetId, key });
  cancelBuild = (planetId: string) => this.call("/build/cancel", { planetId });
  demolish = (planetId: string, key: string) => this.call("/build/demolish", { planetId, key });
  research = (planetId: string, key: string) => this.call("/research", { planetId, key });
  cancelResearch = () => this.call("/research/cancel", {});
  ships = (planetId: string, key: string, qty: number) => this.call("/ships", { planetId, key, qty }); // vaisseaux ET défenses
  cancelShips = (planetId: string) => this.call("/ships/cancel", { planetId });
  setEfficiency = (planetId: string, key: string, percent: number) => this.call("/efficiency", { planetId, key, percent });
  renamePlanet = (planetId: string, name: string) => this.call("/planet/rename", { planetId, name });

  // ---------- Flottes ----------
  // [TESTÉ en transport] ; autres missions [BUNDLE]. coords sans galaxy.
  // Champs optionnels lus dans le bundle (21/09/2026) : `rallier: true` (case « Ralliement » / attendre l'allié, attaque),
  // `heures` (durée d'expédition), `holdHours` (garde sur balise), `coords.body: "moon"` (viser la lune). [BUNDLE]
  sendFleet = (f: {
    planetId: string; mission: Mission; coords: Coords & { body?: "moon" };
    ships: Record<string, number>; cargo?: Res; speedPercent?: number;
    rallier?: boolean; heures?: number; holdHours?: number;
  }) => {
    const { rallier, heures, holdHours, ...rest } = f;
    return this.call("/fleet", {
      speedPercent: 100, cargo: { metal: 0, crystal: 0, deuterium: 0 }, ...rest,
      ...(rallier ? { rallier: true } : {}), ...(heures != null ? { heures } : {}), ...(holdHours != null ? { holdHours } : {}),
    });
  };
  recall = (fleetId: string) => this.call("/fleet/recall", { fleetId });                     // [BUNDLE]
  ralliement = (fleetId: string) => this.call("/fleet/ralliement/lancer", { fleetId });     // [BUNDLE] rôle inconnu
  missiles = (planetId: string, coords: Coords, qty: number, target: string) =>
    this.call("/missiles", { planetId, coords, qty, target });                              // [BUNDLE] target = clé de défense [DÉDUIT]
  jump = (from: string, to: string, ships: Record<string, number>) => this.call("/jump", { from, to, ships }); // [BUNDLE]
  phalanx = (planetId: string, coords: Coords) => this.call("/phalanx", { planetId, coords }); // [BUNDLE]

  // ---------- Commerce / rapports / divers [BUNDLE] ----------
  createTrade = (payload: object) => this.call("/trade/create", payload);                   // forme du body inconnue
  acceptTrade = (tradeId: string, planetId: string, message = "") => this.call("/trade/accept", { tradeId, planetId, message });
  declineTrade = (tradeId: string, message = "") => this.call("/trade/decline", { tradeId, message });
  cancelTrade = (tradeId: string) => this.call("/trade/cancel", { tradeId });
  negociant = (payload: object) => this.call("/negociant", payload);                       // forme du body inconnue
  markReportRead = (reportId: string) => this.call("/reports/read", { reportId });
  dismissReport = (reportId: string) => this.call("/reports/dismiss", { reportId });
  journalier = () => this.call("/journalier", {});                                          // body non lu dans le bundle
  elementDore = () => this.call("/element-dore", {});
}

// ---------- Formules [CALCULÉ] ----------
/** Durée de vol en ms à 100 % — exact à la ms sur 2 flottes réelles. */
export const flightMs = (distance: number, slowestSpeed: number) =>
  Math.ceil((4_800_000 * distance) / slowestSpeed);
/** [HYPOTHÈSE] 2 points seulement, même galaxie. */
export const distance = (sysA: number, sysB: number) => 2700 + 95 * Math.abs(sysA - sysB);
