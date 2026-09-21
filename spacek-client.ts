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
  return s.planets.find((p) => p.id.toLowerCase() === n)
    ?? s.planets.find((p) => norm(p.name) === n)
    ?? s.planets.find((p) => norm(p.name).includes(n)); // « pere » ↔ « Planète Père »
}

export class SpaceK {
  private session: string | null = null;
  private sessionExp = 0; // secondes epoch
  private ticketLogged = false;

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
    if (!r.ok) throw new Error(`Keycloak ${r.status} : re-login Kaiya (fenêtre privée) + recopier refresh_token`);
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

    // [DÉDUIT] mécanisme non vérifié : Location (#kaiya_session= ou ?kaiya_session=), Set-Cookie, ou corps HTML.
    const r = await fetch(url, { redirect: "manual" });
    const loc = r.headers.get("location") ?? "";
    const setCookie = r.headers.get("set-cookie") ?? "";
    const body = await r.text();
    if (!this.ticketLogged) {
      this.ticketLogged = true;
      console.log(new Date().toISOString(), "[auth] échange ticket → status", r.status,
        "headers", JSON.stringify(Object.fromEntries(r.headers)), "body", body.slice(0, 300).replace(/\s+/g, " "));
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
    if (!this.session || Date.now() / 1000 > this.sessionExp - 300) await this.mint();
    return this.session!;
  }

  /** Force un nouveau mint au prochain appel (ex. après un 401). */
  invalidate() { this.session = null; }

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
      // Réponses des POST inconnues → on capture tout pour documenter
      try { appendFileSync(POST_SAMPLES, JSON.stringify({ at: Date.now(), path, body, status: r.status, response: typeof json === "string" ? json.slice(0, 500) : json }) + "\n"); } catch { /* disque plein ? on ignore */ }
    }
    if (!r.ok) throw new Error(`${path} ${r.status}: ${text.slice(0, 200)}`);
    return json as T;
  }

  // ---------- Lecture ----------
  state = () => this.call<State>("/state");                                    // [TESTÉ]
  galaxy = () => this.call("/galaxy/carte");                                   // [BUNDLE]
  leaderboard = () => this.call("/leaderboard");                               // [BUNDLE]
  codex = (planetId: string) => this.call(`/codex?planetId=${encodeURIComponent(planetId)}`); // [BUNDLE]
  profile = (name: string) => this.call(`/profile/${encodeURIComponent(name)}`); // [BUNDLE]
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
  sendFleet = (f: {
    planetId: string; mission: Mission; coords: Coords;
    ships: Record<string, number>; cargo?: Res; speedPercent?: number;
  }) => this.call("/fleet", { speedPercent: 100, cargo: { metal: 0, crystal: 0, deuterium: 0 }, ...f });
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
