#!/bin/sh
# ProofDeck POSIX launcher — mirrors run_daemon.bat on Windows:
#   - restart loop (10s) so a crashed daemon comes back
#   - rc=3 = lost the control-port single-instance race → self-exit (the
#     winner is running; without this every losing loop would retry forever)
#   - rc=0 = clean exit → self-exit
#   - STOP file stops the loop
# Refuses to run without a daemon.config.json (fresh clone / CI: no-op).
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR" || exit 1
[ -f "$DIR/daemon.config.json" ] || exit 0
while :; do
  node "$DIR/daemon.js" "$DIR/daemon.config.json"
  rc=$?
  if [ "$rc" -eq 3 ] || [ "$rc" -eq 0 ]; then exit 0; fi
  [ -f "$DIR/STOP" ] && exit 0
  sleep 10
done
