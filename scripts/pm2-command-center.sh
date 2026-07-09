#!/usr/bin/env bash
# PM2 start wrapper for the orchestrator (Q-20260708-0007).
#
# PM2's ambient env is a frozen snapshot (inherited from whatever shell last ran
# `pm2 start`), so a NEW secret in ~/.env.shared never reaches the process. This
# wrapper sources the live shared env at start so CMD_API_TOKEN (the /api bearer)
# is present. Supervisor-agnostic: the same body works under systemd if CMD ever
# migrates. Run via ecosystem.config.cjs with `interpreter: 'bash'`.
set -a
[ -f "$HOME/.env.shared" ] && . "$HOME/.env.shared"
set +a
exec /usr/bin/node dist/server/server/index.js
