import { useEffect, useState } from 'react';
import { api } from '../api';

interface Agent {
  id: string;
  name: string;
  description: string;
  skills: string[];
  status: string;
  type: string;
  active_mission_id: string | null;
}

interface Capabilities {
  agent_id: string;
  tier: number;
  tools: string[];
  mcp_servers: string[];
  mcp_config_path: string | null;
  can_spawn_sub_agents: boolean;
  max_turns: number;
  timeout: number;
}

const TOOL_LABELS: Record<string, { label: string; color: string }> = {
  Read: { label: 'Read', color: 'bg-gray-700 text-gray-300' },
  Glob: { label: 'Glob', color: 'bg-gray-700 text-gray-300' },
  Grep: { label: 'Grep', color: 'bg-gray-700 text-gray-300' },
  Write: { label: 'Write', color: 'bg-gray-700 text-gray-300' },
  Edit: { label: 'Edit', color: 'bg-gray-700 text-gray-300' },
  Bash: { label: 'Bash', color: 'bg-gray-700 text-gray-300' },
  WebSearch: { label: 'WebSearch', color: 'bg-blue-900 text-blue-300' },
  WebFetch: { label: 'WebFetch', color: 'bg-blue-900 text-blue-300' },
  Agent: { label: 'Agent', color: 'bg-purple-900 text-purple-300' },
};

export function NamedAgents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities[]>([]);

  useEffect(() => {
    api.listAgents().then(data => {
      const named = (data.agents as Agent[]).filter(a => a.type === 'named');
      setAgents(named);
    });
    api.listCapabilities().then(data => {
      setCapabilities(data.capabilities as Capabilities[]);
    });

    const interval = setInterval(() => {
      api.listAgents().then(data => {
        const named = (data.agents as Agent[]).filter(a => a.type === 'named');
        setAgents(named);
      });
    }, 5_000);
    return () => clearInterval(interval);
  }, []);

  const capMap = new Map(capabilities.map(c => [c.agent_id, c]));

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Named Agents</h1>
          <p className="text-sm text-gray-500 mt-1">
            Tier 1 persistent agents with dedicated capabilities. Read-only — config lives in agent.md.
          </p>
        </div>
        <span className="px-3 py-1 bg-gray-800 text-gray-400 rounded text-sm">
          {agents.length} agent{agents.length !== 1 ? 's' : ''}
        </span>
      </div>

      {agents.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <p className="text-lg mb-2">No Named Agents registered</p>
          <p className="text-sm">Named Agents are defined in agents/&lt;name&gt;/ with an agent.md file.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {agents.map(agent => (
            <AgentCard key={agent.id} agent={agent} capabilities={capMap.get(agent.id)} />
          ))}
        </div>
      )}

      <div className="mt-8 p-4 bg-gray-900 border border-gray-800 rounded-lg">
        <h2 className="text-sm font-semibold text-gray-400 mb-3">Tier Access Matrix</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-800">
                <th className="pb-2 pr-4">Capability</th>
                <th className="pb-2 pr-4">Tier 1 Named</th>
                <th className="pb-2 pr-4">Tier 2 Custom</th>
                <th className="pb-2">Tier 3 Stock</th>
              </tr>
            </thead>
            <tbody className="text-gray-300">
              <tr className="border-b border-gray-800/50">
                <td className="py-2 pr-4 text-gray-400">Core tools</td>
                <td className="py-2 pr-4"><Check /></td>
                <td className="py-2 pr-4"><Check /></td>
                <td className="py-2"><Check /></td>
              </tr>
              <tr className="border-b border-gray-800/50">
                <td className="py-2 pr-4 text-gray-400">WebSearch / WebFetch</td>
                <td className="py-2 pr-4"><PerConfig /></td>
                <td className="py-2 pr-4"><Cross /></td>
                <td className="py-2"><Cross /></td>
              </tr>
              <tr className="border-b border-gray-800/50">
                <td className="py-2 pr-4 text-gray-400">MCP servers</td>
                <td className="py-2 pr-4"><PerConfig /></td>
                <td className="py-2 pr-4"><Cross /></td>
                <td className="py-2"><Cross /></td>
              </tr>
              <tr className="border-b border-gray-800/50">
                <td className="py-2 pr-4 text-gray-400">Sub-agents</td>
                <td className="py-2 pr-4"><PerConfig /></td>
                <td className="py-2 pr-4"><Cross /></td>
                <td className="py-2"><Cross /></td>
              </tr>
              <tr className="border-b border-gray-800/50">
                <td className="py-2 pr-4 text-gray-400">Own config dir</td>
                <td className="py-2 pr-4"><Check /></td>
                <td className="py-2 pr-4"><Cross /></td>
                <td className="py-2"><Cross /></td>
              </tr>
              <tr>
                <td className="py-2 pr-4 text-gray-400">Sky-Lynx learning</td>
                <td className="py-2 pr-4"><Check /></td>
                <td className="py-2 pr-4"><Cross /></td>
                <td className="py-2"><Cross /></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function AgentCard({ agent, capabilities }: { agent: Agent; capabilities?: Capabilities }) {
  const statusColor = agent.status === 'available'
    ? 'bg-green-500'
    : agent.status === 'busy'
      ? 'bg-yellow-500'
      : 'bg-gray-500';

  const statusText = agent.status === 'available'
    ? 'Available'
    : agent.status === 'busy'
      ? 'Busy'
      : 'Offline';

  return (
    <div className="p-5 bg-gray-900 border border-gray-800 rounded-lg">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-semibold text-gray-100">{agent.name}</h3>
            <span className="flex items-center gap-1.5 text-xs text-gray-400">
              <span className={`w-2 h-2 rounded-full ${statusColor}`} />
              {statusText}
            </span>
            {capabilities && (
              <span className="px-2 py-0.5 bg-indigo-900/50 text-indigo-300 rounded text-xs font-medium">
                Tier {capabilities.tier}
              </span>
            )}
          </div>
          <p className="text-sm text-gray-400 mt-1">{agent.description}</p>
        </div>
        <span className="text-xs text-gray-600 font-mono shrink-0">{agent.id}</span>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-4">
        {agent.skills.map(skill => (
          <span key={skill} className="px-2 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">
            {skill}
          </span>
        ))}
      </div>

      {capabilities ? (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Tools</h4>
            <div className="flex flex-wrap gap-1.5">
              {capabilities.tools.map(tool => {
                const info = TOOL_LABELS[tool] ?? { label: tool, color: 'bg-gray-700 text-gray-300' };
                return (
                  <span key={tool} className={`px-2 py-0.5 rounded text-xs font-medium ${info.color}`}>
                    {info.label}
                  </span>
                );
              })}
            </div>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">MCP Servers</h4>
            {capabilities.mcp_servers.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {capabilities.mcp_servers.map(mcp => (
                  <span key={mcp} className="px-2 py-0.5 bg-emerald-900/50 text-emerald-300 rounded text-xs font-medium">
                    {mcp}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-xs text-gray-600">None</span>
            )}
          </div>

          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Limits</h4>
            <div className="flex gap-4 text-xs text-gray-400">
              <span>Max turns: <span className="text-gray-200">{capabilities.max_turns}</span></span>
              <span>Timeout: <span className="text-gray-200">{Math.round(capabilities.timeout / 1000)}s</span></span>
            </div>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Flags</h4>
            <div className="flex gap-3 text-xs">
              <span className={capabilities.can_spawn_sub_agents ? 'text-purple-400' : 'text-gray-600'}>
                {capabilities.can_spawn_sub_agents ? 'Can spawn sub-agents' : 'No sub-agents'}
              </span>
              {capabilities.mcp_config_path && (
                <span className="text-emerald-400">Strict MCP isolation</span>
              )}
            </div>
          </div>
        </div>
      ) : (
        <p className="text-xs text-gray-600">No capabilities registered — missing agent.md</p>
      )}
    </div>
  );
}

function Check() {
  return <span className="text-green-400">Yes</span>;
}

function Cross() {
  return <span className="text-gray-600">No</span>;
}

function PerConfig() {
  return <span className="text-blue-400">Per config</span>;
}
