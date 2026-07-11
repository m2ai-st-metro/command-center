#!/usr/bin/env bash
# PM2 start wrapper for coordination-mcp (Q-20260708-0008, folding a dump-only app into
# ecosystem.config.cjs).
#
# coordination-mcp reads COORDINATION_MCP_TOKEN, SPARK_OAUTH_CLIENT_ID, SPARK_OAUTH_CLIENT_SECRET
# from process.env (src/index.ts). PM2's ambient env is a frozen snapshot from whatever shell
# last ran `pm2 start` (Q-20260708-0007), so source the live shared env here instead.
set -a
[ -f "$HOME/.env.shared" ] && . "$HOME/.env.shared"
set +a
exec /usr/bin/node /home/apexaipc/projects/coordination-mcp/dist/index.js
