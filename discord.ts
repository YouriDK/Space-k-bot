// Notifications Discord par webhook (aucun bot, aucun token : un simple POST sur l'URL du webhook d'un salon).
// Utilisé uniquement pour les alertes pirates. DISCORD_WEBHOOK_URL vide → désactivé silencieusement.
import { log } from "./core.ts";

const URL = (process.env.DISCORD_WEBHOOK_URL ?? "").trim();
export const discordEnabled = () => !!URL;

export async function postDiscord(content: string) {
  if (!URL) return;
  try {
    const r = await fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: content.slice(0, 1950), username: "Space-K Bot" }) });
    if (!r.ok) log("Discord webhook", r.status, (await r.text()).slice(0, 120));
  } catch (e: any) { log("Discord webhook KO", e.message); }
}
