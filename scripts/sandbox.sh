#!/bin/bash
# Lance la NOUVELLE Tars en bac à sable, à côté de l'app de prod.
#
# Isolation :
#   - HOME pointé sur ~/Tars-sandbox  → ~/.dorothy (agents, settings, token),
#     ~/.claude (mémoire, MCP, hooks) et ~/Library/Application Support/Tars
#     (localStorage, fenêtres) sont des copies de test, jamais les vrais.
#   - API sur le port 31499              → aucun conflit avec la prod (31415).
#   - Les hooks suivent CLAUDE_MGR_API_URL, que Tars injecte depuis
#     DOROTHY_API_PORT : un agent du bac poste donc bien sur 31499. Ils
#     codaient 31415 en dur, et la promesse ci-dessous etait fausse.
#
# La prod qui tourne n'est ni vue, ni touchée. Le bac à sable est PERSISTANT
# entre les lancements (settings/agents de test conservés) :
#   rm -rf ~/Tars-sandbox   pour repartir de zéro.
#
# Note agents réels : l'auth du claude CLI vit dans le trousseau macOS (pas
# dans HOME), donc les agents spawnés depuis le bac à sable sont généralement
# déjà authentifiés. Si un agent demande un login, c'est que tes credentials
# sont en fichier : claude /login une fois depuis le bac à sable suffit.

set -e

SANDBOX="$HOME/Tars-sandbox"
APP="${1:-$(dirname "$0")/../release/mac-arm64/Tars.app}"
BIN="$APP/Contents/MacOS/Tars"

if [ ! -x "$BIN" ]; then
  echo "App introuvable: $APP"
  echo "Construis-la d'abord (next build + npm run electron:pack) ou passe le chemin: scripts/sandbox.sh /chemin/Tars.app"
  exit 1
fi

mkdir -p "$SANDBOX"
echo "Sandbox HOME : $SANDBOX"
echo "API port     : 31499 (prod intacte sur 31415)"
echo "App          : $APP"

LOG="$SANDBOX/tars.log"
HOME="$SANDBOX" DOROTHY_API_PORT=31499 nohup "$BIN" "$@" > "$LOG" 2>&1 &
disown
echo "PID $! — les deux Tars tournent en parallèle. Logs: $LOG"
