#!/data/data/com.termux/files/usr/bin/bash
# Mise à jour du bot sur le téléphone depuis GitHub, sans le Mac (lancé par /maj, ou à la main : bash update.sh).
# Installation initiale (une seule fois, dans Termux) :
#   pkg install -y git curl && curl -fsSL https://raw.githubusercontent.com/YouriDK/Space-k-bot/main/update.sh | bash
#
# Déroulé : clone (ou fetch + reset) du dépôt dans SPACEK_REPO_DIR (zone de transit, jamais modifiée à la main)
#   → ré-exécution depuis le clone (la logique de mise à jour est toujours celle de la version déployée)
#   → sauvegarde du code actuel dans SPACEK_BACKUP_DIR/<date-heure>-avant-maj/ → copie des fichiers suivis par git
#   → marqueur .update-pending → pm2 restart → le nouveau bot supprime le marqueur une fois opérationnel (maj.ts).
# Marqueur encore là après SPACEK_UPDATE_WAIT s : retour arrière (sauvegarde restaurée, fichiers ajoutés supprimés,
# pm2 restart) et message Telegram direct par curl avec les dernières lignes de pm2 logs.
# JAMAIS copiés (état vivant du téléphone) : *.json (build-plan.json, package*.json, tsconfig.json compris), .env,
# refresh_token.txt*, *.jsonl. package.json / package-lock.json différents → signalé, npm install reste manuel.
# Journal : update.log dans le dossier du bot. Verrou : .update-lock (une seule mise à jour à la fois).
# Variables (pour tester ailleurs) : SPACEK_REPO_DIR SPACEK_BOT_DIR SPACEK_BACKUP_DIR SPACEK_REPO_URL SPACEK_BRANCH
#   SPACEK_PM2_NAME SPACEK_UPDATE_WAIT (s) SPACEK_TG_API SPACEK_FORCE=1 (redéploie même si déjà à jour).
# Uniquement des commandes communes à Termux et macOS (pas de readlink -f, sed -i, sha256sum, date -d…).

main() {
  REPO_DIR="${SPACEK_REPO_DIR:-$HOME/spacek-repo}"
  BOT_DIR="${SPACEK_BOT_DIR:-$HOME/spacek-bot}"
  BACKUP_ROOT="${SPACEK_BACKUP_DIR:-$HOME/spacek-backups}"
  REPO_URL="${SPACEK_REPO_URL:-https://github.com/YouriDK/Space-k-bot.git}"
  BRANCH="${SPACEK_BRANCH:-main}"
  PM2_NAME="${SPACEK_PM2_NAME:-spacek}"
  WAIT_S="${SPACEK_UPDATE_WAIT:-90}"
  TG_API="${SPACEK_TG_API:-https://api.telegram.org}"
  KEEP_BACKUPS=10
  export GIT_TERMINAL_PROMPT=0 # jamais de demande d'identifiants (dépôt public) : échec net plutôt qu'un blocage

  mkdir -p "$BOT_DIR" || { echo "Dossier du bot impossible à créer : $BOT_DIR" >&2; return 1; }
  LOG="$BOT_DIR/update.log"
  LOCK="$BOT_DIR/.update-lock"
  MARKER="$BOT_DIR/.update-pending"
  VERSION_FILE="$BOT_DIR/.version"

  # ---------- Verrou (mkdir = atomique) ; repris tel quel après la ré-exécution (même pid) ----------
  if [ "${SPACEK_UPDATE_REEXEC:-}" = 1 ] && [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ]; then
    :
  elif ! take_lock; then
    return 1
  fi
  trap 'rm -rf "$LOCK"' EXIT
  trap 'exit 1' INT TERM

  # ---------- Clone / fetch, puis ré-exécution depuis le clone ----------
  if [ "${SPACEK_UPDATE_REEXEC:-}" != 1 ]; then
    log "===== mise à jour ($REPO_URL, branche $BRANCH) ====="
    sync_repo || return 1
    if [ ! -f "$REPO_DIR/update.sh" ]; then log "❌ update.sh absent du dépôt"; return 1; fi
    export SPACEK_UPDATE_REEXEC=1 # garde-fou : la copie ré-exécutée ne refait ni le fetch ni la ré-exécution
    trap - EXIT                   # le verrou passe à la copie ré-exécutée (exec garde le pid)
    exec bash "$REPO_DIR/update.sh" "$@"
  fi
  if [ ! -d "$REPO_DIR/.git" ]; then log "❌ clone absent : $REPO_DIR"; return 1; fi

  NEW=$(git -C "$REPO_DIR" rev-parse HEAD 2>>"$LOG") || { log "❌ rev-parse impossible"; return 1; }
  OLD=$(tr -d ' \r\n' 2>/dev/null <"$VERSION_FILE")
  [ -n "$OLD" ] || OLD=inconnu
  if [ -f "$MARKER" ]; then log "marqueur d'une mise à jour interrompue supprimé"; rm -f "$MARKER"; fi
  if [ "$OLD" = "$NEW" ] && [ "${SPACEK_FORCE:-}" != 1 ]; then
    log "✅ déjà à jour (${NEW:0:7})"
    return 0
  fi
  log "déploiement ${OLD:0:7} → ${NEW:0:7}"

  # ---------- Fichiers autorisés : suivis par git, hors *.json / *.jsonl / secrets ----------
  FILES=$(git -C "$REPO_DIR" ls-files | grep -vE '(^|/)(\.env|refresh_token\.txt[^/]*)$|\.jsonl?$')
  if [ -z "$FILES" ]; then log "❌ aucun fichier à copier"; return 1; fi

  # ---------- package.json / package-lock.json : signalés, jamais copiés ----------
  DEPS=""
  for f in package.json package-lock.json; do
    if [ -f "$REPO_DIR/$f" ] && ! cmp -s "$REPO_DIR/$f" "$BOT_DIR/$f"; then DEPS="$DEPS $f"; fi
  done
  DEPS="${DEPS# }"
  [ -z "$DEPS" ] || log "⚠️ $DEPS différent(s) du dépôt : non copié(s), npm install à faire à la main"

  # ---------- Sauvegarde du code actuel ----------
  BACKUP="$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)-avant-maj"
  mkdir -p "$BACKUP" || { log "❌ sauvegarde impossible : $BACKUP"; return 1; }
  : >"$BACKUP/.nouveaux"
  echo "$OLD" >"$BACKUP/.version"
  while IFS= read -r f; do
    if [ -e "$BOT_DIR/$f" ]; then
      mkdir -p "$BACKUP/$(dirname "$f")" && cp -p "$BOT_DIR/$f" "$BACKUP/$f" || { log "❌ sauvegarde de $f impossible"; return 1; }
    else
      echo "$f" >>"$BACKUP/.nouveaux"
    fi
  done <<EOF
$FILES
EOF
  log "sauvegarde : $BACKUP"

  # ---------- Copie + marqueur ----------
  while IFS= read -r f; do
    if ! { mkdir -p "$BOT_DIR/$(dirname "$f")" && cp "$REPO_DIR/$f" "$BOT_DIR/$f"; }; then
      log "❌ copie de $f impossible → retour arrière"
      restore; return 1
    fi
  done <<EOF
$FILES
EOF
  echo "$NEW" >"$VERSION_FILE"
  printf 'new=%s\nold=%s\nbackup=%s\ndeps=%s\n' "$NEW" "$OLD" "$BACKUP" "$DEPS" >"$MARKER"
  log "$(printf '%s\n' "$FILES" | wc -l | tr -d ' ') fichier(s) copié(s)"

  # ---------- Redémarrage ----------
  if ! command -v pm2 >/dev/null 2>&1 || ! pm2 jlist 2>/dev/null | grep -q "\"name\":\"$PM2_NAME\""; then
    rm -f "$MARKER"
    log "⚠️ process pm2 « $PM2_NAME » introuvable : code copié sans redémarrage."
    log "   Première installation : bash $BOT_DIR/setup-termux.sh, puis pm2 start \"npx tsx --env-file=.env telegram.ts\" --name $PM2_NAME && pm2 save"
    prune_backups
    return 0
  fi
  log "pm2 restart $PM2_NAME"
  pm2 restart "$PM2_NAME" >>"$LOG" 2>&1 || log "⚠️ pm2 restart en erreur"

  # ---------- Attente de la confirmation du nouveau bot (suppression du marqueur) ----------
  waited=0
  while [ -f "$MARKER" ] && [ "$waited" -lt "$WAIT_S" ]; do sleep 1; waited=$((waited + 1)); done
  if [ ! -f "$MARKER" ]; then
    log "✅ mise à jour en place : ${OLD:0:7} → ${NEW:0:7} (confirmée par le bot après ${waited} s)"
    prune_backups
    return 0
  fi

  # ---------- Retour arrière ----------
  log "❌ le bot n'a pas confirmé en ${WAIT_S} s → retour arrière"
  LOGS=$(pm2 logs "$PM2_NAME" --nostream --lines 15 2>&1 | tr -d '\033' | sed 's/\[[0-9;]*m//g' | tail -n 40)
  printf '%s\n' "--- pm2 logs (nouvelle version) ---" "$LOGS" "---" >>"$LOG"
  restore
  rm -f "$MARKER"
  log "pm2 restart $PM2_NAME (ancienne version)"
  pm2 restart "$PM2_NAME" >>"$LOG" 2>&1 || log "⚠️ pm2 restart en erreur"
  notify "❌ Mise à jour ${NEW:0:7} annulée : le bot n'a pas redémarré, ancienne version restaurée (${OLD:0:7}).
Dernières lignes de pm2 logs :
$(printf '%s' "$LOGS" | tail -c 3000)"
  return 2
}

log() {
  local l
  l="$(date '+%Y-%m-%d %H:%M:%S') $*"
  echo "$l" >>"$LOG"
  [ -t 2 ] && echo "$l" >&2 # à la main dans un terminal : aussi à l'écran (lancé par /maj, stderr va déjà dans update.log)
  return 0
}

take_lock() {
  local pid
  if mkdir "$LOCK" 2>/dev/null; then echo $$ >"$LOCK/pid"; return 0; fi
  pid=$(cat "$LOCK/pid" 2>/dev/null)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    log "⛔ une mise à jour est déjà en cours (pid $pid)"
    return 1
  fi
  log "verrou orphelin (pid ${pid:-?}) supprimé"
  rm -rf "$LOCK"
  if mkdir "$LOCK" 2>/dev/null; then echo $$ >"$LOCK/pid"; return 0; fi
  log "⛔ verrou impossible à prendre : $LOCK"
  return 1
}

# Clone s'il n'existe pas, sinon fetch + reset --hard : le clone n'est qu'une zone de transit.
sync_repo() {
  if [ -d "$REPO_DIR/.git" ]; then
    git -C "$REPO_DIR" remote set-url origin "$REPO_URL" >>"$LOG" 2>&1
    git -C "$REPO_DIR" fetch --quiet origin "$BRANCH" >>"$LOG" 2>&1 || { log "❌ git fetch impossible (réseau ?)"; return 1; }
    git -C "$REPO_DIR" checkout --quiet -B "$BRANCH" "origin/$BRANCH" >>"$LOG" 2>&1 &&
      git -C "$REPO_DIR" reset --quiet --hard "origin/$BRANCH" >>"$LOG" 2>&1 &&
      git -C "$REPO_DIR" clean --quiet -fdx >>"$LOG" 2>&1 || { log "❌ reset du clone impossible"; return 1; }
  else
    if [ -e "$REPO_DIR" ] && [ -n "$(ls -A "$REPO_DIR" 2>/dev/null)" ]; then log "❌ $REPO_DIR existe et n'est pas un clone git"; return 1; fi
    log "clone de $REPO_URL dans $REPO_DIR"
    git clone --quiet --branch "$BRANCH" "$REPO_URL" "$REPO_DIR" >>"$LOG" 2>&1 || { log "❌ git clone impossible (git installé ? réseau ?)"; return 1; }
  fi
  log "dépôt à jour : $(git -C "$REPO_DIR" log -1 --format='%h %s' 2>/dev/null)"
}

# Remet les fichiers sauvegardés, supprime ceux que la mise à jour a ajoutés, rétablit .version.
restore() {
  local f
  while IFS= read -r f; do
    [ -n "$f" ] && [ -f "$BACKUP/$f" ] && cp -p "$BACKUP/$f" "$BOT_DIR/$f"
  done <<EOF
$FILES
EOF
  while IFS= read -r f; do
    [ -n "$f" ] && rm -f "$BOT_DIR/$f" && log "supprimé (ajouté par la mise à jour) : $f"
  done <"$BACKUP/.nouveaux"
  if [ "$OLD" = inconnu ]; then rm -f "$VERSION_FILE"; else echo "$OLD" >"$VERSION_FILE"; fi
  log "ancienne version restaurée depuis $BACKUP"
}

# Garde les KEEP_BACKUPS sauvegardes les plus récentes (noms horodatés : l'ordre alphabétique est chronologique).
prune_backups() {
  local list n
  list=$(ls -1d "$BACKUP_ROOT"/*-avant-maj 2>/dev/null | sort)
  n=$(printf '%s' "$list" | grep -c .)
  [ "$n" -gt "$KEEP_BACKUPS" ] || return 0
  printf '%s\n' "$list" | sed -n "1,$((n - KEEP_BACKUPS))p" | while IFS= read -r d; do rm -rf "$d"; done
}

# Message Telegram direct (le bot ne répond peut-être plus) : TG_TOKEN / TG_CHAT_ID lus dans le .env, jamais affichés.
notify() {
  local token chat code
  token=$(sed -n 's/^TG_TOKEN=//p' "$BOT_DIR/.env" 2>/dev/null | head -n 1 | tr -d "\"' \r")
  chat=$(sed -n 's/^TG_CHAT_ID=//p' "$BOT_DIR/.env" 2>/dev/null | head -n 1 | tr -d "\"' \r")
  if [ -z "$token" ] || [ -z "$chat" ]; then log "pas de TG_TOKEN / TG_CHAT_ID dans .env : pas de message Telegram"; return 0; fi
  if ! command -v curl >/dev/null 2>&1; then log "curl absent : pas de message Telegram (pkg install curl)"; return 0; fi
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 --data-urlencode "chat_id=$chat" --data-urlencode "text=$1" "$TG_API/bot$token/sendMessage")
  log "message Telegram envoyé (HTTP $code)"
}

# Tout le script est lu avant de s'exécuter (curl | bash, fichier remplacé pendant l'exécution) ; stdin coupé pour
# que git / pm2 ne consomment pas la suite du script quand il arrive par un tube.
main "$@" </dev/null
exit $?
