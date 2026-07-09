#!/usr/bin/env bash
# PM2 start wrapper for cmd-mcp (Q-20260708-0007).
#
# cmd-mcp calls CMD's mutating /api routes (missions, schedules, tasks) over the
# Cloudflare-tunneled path, so it must send the CMD_API_TOKEN bearer. Its PM2 env
# does not carry ~/.env.shared, so source it here. See pm2-command-center.sh.
set -a
[ -f "$HOME/.env.shared" ] && . "$HOME/.env.shared"
set +a
exec /usr/bin/node dist/server/mcp/index.js
