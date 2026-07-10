module.exports = {
  apps: [
    {
      name: 'command-center',
      // Q-20260708-0007: start via wrapper that sources ~/.env.shared so the
      // CMD_API_TOKEN /api bearer reaches the process (PM2's ambient env is frozen).
      script: 'scripts/pm2-command-center.sh',
      interpreter: 'bash',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        COMMAND_CENTER_PORT: '3142',
      },
      exp_backoff_restart_delay: 1000,
      max_restarts: 10,
      min_uptime: '10s',
    },
    {
      name: 'agent-research',
      script: 'node_modules/.bin/tsx',
      args: 'agents/research/index.ts',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        RESEARCH_AGENT_PORT: '3143',
      },
      exp_backoff_restart_delay: 1000,
      max_restarts: 10,
      min_uptime: '10s',
    },
    {
      name: 'agent-coding',
      script: 'node_modules/.bin/tsx',
      args: 'agents/coding/index.ts',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        CODING_AGENT_PORT: '3144',
      },
      exp_backoff_restart_delay: 1000,
      max_restarts: 10,
      min_uptime: '10s',
    },
    {
      name: 'agent-content',
      script: 'node_modules/.bin/tsx',
      args: 'agents/content/index.ts',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        CONTENT_AGENT_PORT: '3145',
      },
      exp_backoff_restart_delay: 1000,
      max_restarts: 10,
      min_uptime: '10s',
    },
    {
      name: 'agent-data',
      script: 'node_modules/.bin/tsx',
      args: 'agents/data/index.ts',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        DATA_AGENT_PORT: '3146',
      },
      exp_backoff_restart_delay: 1000,
      max_restarts: 10,
      min_uptime: '10s',
    },
    {
      name: 'agent-kup',
      script: 'node_modules/.bin/tsx',
      args: 'agents/kup/index.ts',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        KUP_AGENT_PORT: '3147',
      },
      exp_backoff_restart_delay: 1000,
      max_restarts: 10,
      min_uptime: '10s',
    },
    {
      // Remote MCP server exposing CMD's API to Claude Cowork Live Artifacts.
      // Auth is handled by Cloudflare Access in front of the tunnel (Phase 2),
      // so bearer token is intentionally NOT injected here. If bearer auth is
      // ever re-enabled as defense-in-depth, source ~/.env.shared with
      // `set -a && source ~/.env.shared && set +a` before starting pm2.
      name: 'cmd-mcp',
      // Q-20260708-0007: wrapper sources ~/.env.shared so cmd-mcp sends the
      // CMD_API_TOKEN bearer on its outbound calls to CMD's mutating /api routes.
      script: 'scripts/pm2-cmd-mcp.sh',
      interpreter: 'bash',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        MCP_TRANSPORT: 'http',
        MCP_PORT: '3150',
        MCP_HOST: '127.0.0.1',
        CMD_BASE_URL: 'http://localhost:3142',
      },
      exp_backoff_restart_delay: 1000,
      max_restarts: 10,
      min_uptime: '10s',
    },
    {
      // Cloudflare named tunnel: exposes mcp.st-metro.dev -> cmd-mcp on :3150.
      // Config: ~/.cloudflared/config.yml.  Cert + credentials also in ~/.cloudflared/.
      // Keeps HTTP/2 transport because QUIC is blocked on this network.
      name: 'cloudflared-cmd-mcp',
      script: '/home/apexaipc/bin/cloudflared',
      args: 'tunnel --config /home/apexaipc/.cloudflared/config.yml --no-autoupdate run cmd-mcp',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
      },
      exp_backoff_restart_delay: 1000,
      max_restarts: 10,
      min_uptime: '10s',
    },
  ],
};
