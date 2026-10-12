#!/usr/bin/env bash
#
# Makes the Factory's supervisor start by itself after a restart (TASK-019 AC-19).
#
# WHAT THIS IS FOR. Everything else in this task is about surviving the death of
# a process; this is about surviving the death of the MACHINE. A supervisor that
# an operator has to start by opening a terminal is a supervisor that is not
# running for however long it takes somebody to notice — which is the same
# twenty-hour gap the whole task exists to close, arriving by a different route.
#
# IT DETECTS RATHER THAN ASSUMES. WSL may or may not have a systemd user session,
# depending on `/etc/wsl.conf` and the Windows build, and being wrong about that
# silently installs a unit that never runs. So the environment is measured, and
# when the measurement says "this cannot start itself", the script says exactly
# that and names the ONE action a person must take rather than pretending.
#
# It asks for no privilege it does not need: a user unit and `--user` linger are
# tried first, and `sudo` is never invoked.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/sf-supervisor.service"
NODE_BIN="$(command -v node || true)"

say() { printf '%s\n' "$*"; }

if [ -z "$NODE_BIN" ]; then
  say "REFUSED: node is not on PATH, so nothing could be started at boot either."
  say "Install node (or source nvm in a login shell) and run this again."
  exit 1
fi

if [ ! -f "$REPO/dist/src/cli/main.js" ]; then
  say "REFUSED: $REPO/dist/src/cli/main.js does not exist. Build first: npm run build"
  exit 1
fi

# ---- does this machine have a systemd USER session at all? -----------------
HAS_SYSTEMD_USER=no
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  HAS_SYSTEMD_USER=yes
fi

if [ "$HAS_SYSTEMD_USER" = "yes" ]; then
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT" <<UNITEOF
[Unit]
Description=Software Factory supervisor
# Not After=network: this supervises a local repository and must come up even
# when nothing else does. A supervisor that waits for the network to decide it
# may run is a supervisor that is down whenever the network is.
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=$REPO
ExecStart=$NODE_BIN $REPO/dist/src/cli/main.js supervisor run
# RESTART THE DETERMINISTIC SUPERVISOR, never a model. If this exits, the right
# response is to start it again: its state is durable and its work is idempotent,
# so a restart costs one reconciliation tick and nothing else.
Restart=always
RestartSec=10
# The supervisor's own refusals are its output; losing them to a rotated journal
# is how "nothing happened" became indistinguishable from "nobody looked".
StandardOutput=append:$HOME/.software-factory/supervisor.log
StandardError=append:$HOME/.software-factory/supervisor.log

[Install]
WantedBy=default.target
UNITEOF

  mkdir -p "$HOME/.software-factory"
  systemctl --user daemon-reload
  systemctl --user enable --now sf-supervisor.service
  say "installed: $UNIT"
  systemctl --user --no-pager status sf-supervisor.service | head -5

  # Linger makes a user service survive logout. It usually needs privilege, so
  # it is TRIED and its failure is reported as the one named action rather than
  # escalated silently.
  if ! loginctl enable-linger "$USER" >/dev/null 2>&1; then
    say ""
    say "ONE ACTION LEFT (needs privilege, so it is not done for you):"
    say "  sudo loginctl enable-linger $USER"
    say "Without it the supervisor stops when your session ends."
  fi
  exit 0
fi

# ---- no systemd user session: say so, and name the single Windows action ----
BOOT="$HOME/.software-factory/start-supervisor.sh"
mkdir -p "$(dirname "$BOOT")"
cat > "$BOOT" <<BOOTEOF
#!/usr/bin/env bash
# Started by Windows at login; keeps the supervisor up inside WSL.
export NVM_DIR="\$HOME/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh" >/dev/null 2>&1
mkdir -p "\$HOME/.software-factory"
cd "$REPO" || exit 9
while :; do
  node "$REPO/dist/src/cli/main.js" supervisor run >> "\$HOME/.software-factory/supervisor.log" 2>&1
  # Same rule as the systemd unit: restart the deterministic supervisor.
  sleep 10
done
BOOTEOF
chmod +x "$BOOT"

say "This WSL distribution has no systemd user session, so a user unit would never start."
say "Wrote the boot script instead: $BOOT"
say ""
say "ONE ACTION LEFT, on the Windows side (a human-only step — it is outside WSL):"
say "  Create a Startup shortcut or Task Scheduler entry that runs, at logon:"
say "    wsl.exe -d ${WSL_DISTRO_NAME:-Ubuntu} -- bash -lc \"$BOOT\""
say ""
say "Nothing else is required: the supervisor recovers its own state on start."
exit 0
