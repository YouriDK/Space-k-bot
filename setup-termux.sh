#!/data/data/com.termux/files/usr/bin/bash
# Installation du serveur Space-K sur Android (Termux F-Droid / GitHub, PAS Play Store).
# Prérequis : le dossier du projet copié dans ~/spacek-bot (scp, git clone ou adb push).
set -e
cd ~/spacek-bot

pkg update -y
pkg install -y nodejs openssh git
[ -f package.json ] || npm init -y >/dev/null
npm i -D tsx typescript @types/node
npm i -g pm2

# Wake-lock : nécessite l'app Termux:API (sinon garder Termux au premier plan / whitelist batterie via adb)
termux-wake-lock || echo "⚠️ termux-wake-lock indisponible : installe Termux:API"

# Relance automatique au démarrage du téléphone (nécessite l'app Termux:Boot, lancée une fois)
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/start-spacek.sh <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
sshd
cd ~/spacek-bot && pm2 resurrect
EOF
chmod +x ~/.termux/boot/start-spacek.sh

# Config par défaut : MODE OBSERVATION (aucun envoi automatique tant que les flags sont à false)
if [ ! -f .env ]; then
  cat > .env <<'EOF'
TG_TOKEN=
TG_CHAT_ID=
SAVE_ARMED=false
SUPPLY_ENABLED=false
COLLECT_ENABLED=false
AUTOBUILD_ENABLED=false
HEARTBEAT_H=6
REFRESH_FILE=./refresh_token.txt
EOF
fi
chmod 600 .env
[ -f refresh_token.txt ] && chmod 600 refresh_token.txt || echo "⚠️ refresh_token.txt manquant (copier depuis une fenêtre privée : localStorage.refresh_token sur kaiya.kreactive.fr)"

echo "
Étapes suivantes :
 1. Remplis TG_TOKEN dans ~/spacek-bot/.env
 2. npx tsx --env-file=.env telegram.ts   → écris à ton bot, il te donne ton chat id
 3. Mets TG_CHAT_ID dans .env, puis :
    pm2 start \"npx tsx --env-file=.env telegram.ts\" --name spacek && pm2 save
 4. Logs : pm2 logs spacek
 5. Quand les données d'observation sont bonnes : /save on depuis Telegram (ou SAVE_ARMED=true)
"
