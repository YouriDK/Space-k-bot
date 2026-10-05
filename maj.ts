// /maj : mise à jour du bot depuis GitHub, sans le Mac ni le même réseau. Le gros du travail (copie, pm2 restart, retour
// arrière) est fait par update.sh, DÉTACHÉ du bot : pm2 tue l'arbre de processus du bot au redémarrage, le script doit donc
// être ré-attaché à init avant (sh intermédiaire qui se termine tout de suite). Ici : état du clone et commits à déployer,
// lancement du script, et confirmation au démarrage du nouveau code (le marqueur .update-pending est supprimé une fois le
// bot opérationnel ; s'il est encore là au bout de 90 s, update.sh remet l'ancienne version). Aucun import de bot.ts.
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { log } from "./core.ts";

const exec = promisify(execFile);
export const REPO_DIR = process.env.SPACEK_REPO_DIR || join(process.env.HOME ?? ".", "spacek-repo");
const REPO_URL = process.env.SPACEK_REPO_URL || "https://github.com/YouriDK/Space-k-bot.git";
const BRANCH = process.env.SPACEK_BRANCH || "main";
// pm2 injecte `name` et `pm_id` dans l'environnement du process qu'il gère
const PM2_NAME = process.env.SPACEK_PM2_NAME || (process.env.pm_id != null && process.env.name) || "spacek";
const BOT_DIR = process.cwd(); // pm2 lance le bot depuis ~/spacek-bot
const MARKER = join(BOT_DIR, ".update-pending");
const VERSION = join(BOT_DIR, ".version");
const LOCK = join(BOT_DIR, ".update-lock");
const MAX_COMMITS = 15;
const CONFIRM_AFTER_MS = 15_000; // le nouveau code doit tenir 15 s (chargement des modules, 1er tour de watch) avant de se déclarer en place

export const shortSha = (sha?: string) => (sha && /^[0-9a-f]{7,}$/.test(sha) ? sha.slice(0, 7) : sha || "inconnue");

async function git(...args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd: existsSync(REPO_DIR) ? REPO_DIR : undefined, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return stdout.trim();
  } catch (e: any) {
    if (e.code === "ENOENT") throw new Error("git introuvable sur le téléphone : pkg install -y git");
    throw new Error(`git ${args[0]} : ${String(e.stderr || e.message).trim().split("\n").slice(-2).join(" ").slice(0, 300)}`);
  }
}

/** Mise à jour en cours (verrou d'update.sh tenu par un process vivant) → son pid. */
export function updateRunning(): number | null {
  try {
    const pid = Number(readFileSync(join(LOCK, "pid"), "utf8").trim());
    if (!pid) return null;
    process.kill(pid, 0); // lève si le process n'existe plus (verrou orphelin)
    return pid;
  } catch { return null; }
}

export type UpdateCheck = { current?: string; latest: string; commits: string[]; more: number; deps: string[]; cloned: boolean };

/** Fetch dans le clone (créé s'il n'existe pas encore) et comparaison avec .version (sha déployé sur le téléphone). */
export async function checkUpdate(): Promise<UpdateCheck> {
  let cloned = false;
  if (!existsSync(join(REPO_DIR, ".git"))) {
    if (existsSync(REPO_DIR) && readdirSync(REPO_DIR).length) throw new Error(`${REPO_DIR} existe mais n'est pas un clone git : à supprimer ou à renommer`);
    await git("clone", "--quiet", "--branch", BRANCH, REPO_URL, REPO_DIR);
    cloned = true;
  } else await git("fetch", "--quiet", "origin", BRANCH);
  const ref = `origin/${BRANCH}`;
  const latest = await git("rev-parse", ref);
  const current = existsSync(VERSION) ? readFileSync(VERSION, "utf8").trim() || undefined : undefined;
  if (current === latest) return { current, latest, commits: [], more: 0, deps: [], cloned };
  // Commits à déployer ; version inconnue (1re fois, ou historique réécrit) → les derniers commits du dépôt
  const known = current ? await git("cat-file", "-e", `${current}^{commit}`).then(() => true, () => false) : false;
  let lines = known ? (await git("log", "--format=%h %s", `${current}..${ref}`)).split("\n").filter(Boolean) : [];
  if (!lines.length) lines = (await git("log", "-n", String(MAX_COMMITS + 1), "--format=%h %s", ref)).split("\n").filter(Boolean);
  const deps: string[] = [];
  for (const f of ["package.json", "package-lock.json"]) {
    const remote = await git("show", `${ref}:${f}`).catch(() => null);
    const local = existsSync(join(BOT_DIR, f)) ? readFileSync(join(BOT_DIR, f), "utf8").trim() : "";
    if (remote != null && remote !== local) deps.push(f);
  }
  const trunc = (l: string) => (l.length > 90 ? `${l.slice(0, 89)}…` : l);
  return { current, latest, commits: lines.slice(0, MAX_COMMITS).map(trunc), more: Math.max(0, lines.length - MAX_COMMITS), deps, cloned };
}

/** Lance update.sh hors de l'arbre de processus du bot : `sh -c "nohup bash … &"` se termine aussitôt, le script est
 *  ré-attaché à init et survit au pm2 restart (treekill). Le script du bot se ré-exécute ensuite depuis le clone. */
export function launchUpdate() {
  if (updateRunning()) throw new Error("Une mise à jour est déjà en cours");
  const script = existsSync(join(BOT_DIR, "update.sh")) ? join(BOT_DIR, "update.sh") : join(REPO_DIR, "update.sh");
  if (!existsSync(script)) throw new Error(`update.sh introuvable (${script})`);
  spawn("sh", ["-c", 'nohup bash "$1" >> "$2" 2>&1 &', "sh", script, join(BOT_DIR, "update.log")], {
    cwd: BOT_DIR, detached: true, stdio: "ignore",
    env: { ...process.env, SPACEK_BOT_DIR: BOT_DIR, SPACEK_REPO_DIR: REPO_DIR, SPACEK_REPO_URL: REPO_URL, SPACEK_BRANCH: BRANCH, SPACEK_PM2_NAME: PM2_NAME },
  }).unref();
  log("MAJ lancée :", script);
}

/** Au démarrage : une mise à jour attend sa confirmation (marqueur présent) → après CONFIRM_AFTER_MS et un appel Telegram
 *  réussi (`ping`), annonce « ✅ Mise à jour en place » et supprime le marqueur : update.sh arrête alors d'attendre.
 *  Le jeu injoignable ne bloque pas la confirmation (ce n'est pas un défaut du nouveau code). */
export function confirmUpdateOnStart(ping: () => Promise<unknown>, notify: (msg: string) => void) {
  if (!existsSync(MARKER)) return;
  const raw = readFileSync(MARKER, "utf8");
  const m = Object.fromEntries(raw.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
  const attempt = async () => {
    try { await ping(); } catch (e: any) { log("MAJ : Telegram pas encore joignable", e.message); return setTimeout(attempt, 5_000); }
    // update.sh a pu abandonner entre-temps (retour arrière) : on ne confirme que le marqueur lu au démarrage
    if (!existsSync(MARKER) || readFileSync(MARKER, "utf8") !== raw) return;
    try { unlinkSync(MARKER); } catch (e: any) { log("MAJ : marqueur non supprimé", e.message); return; }
    log("MAJ confirmée", m.old, "→", m.new);
    notify(`✅ Mise à jour en place : ${shortSha(m.old)} → ${shortSha(m.new)}` +
      (m.deps ? `\n⚠️ ${m.deps.split(/\s+/).join(", ")} différent(s) du dépôt : non copié(s). Si une dépendance a changé : npm install à faire à la main (ssh), puis pm2 restart ${PM2_NAME}.` : ""));
  };
  setTimeout(attempt, CONFIRM_AFTER_MS);
}
