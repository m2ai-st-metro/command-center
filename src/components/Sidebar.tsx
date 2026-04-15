import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../api';

interface Agent {
  id: string;
  name: string;
  status: string;
  type: string;
  active_mission_id: string | null;
}

export function Sidebar() {
  const location = useLocation();
  const [agents, setAgents] = useState<Agent[]>([]);

  useEffect(() => {
    api.listAgents().then((data) => setAgents(data.agents as Agent[]));
    const interval = setInterval(() => {
      api.listAgents().then((data) => setAgents(data.agents as Agent[]));
    }, 10_000);
    return () => clearInterval(interval);
  }, []);

  const statusColor = (s: string) => {
    if (s === 'available') return 'bg-green-500';
    if (s === 'busy') return 'bg-yellow-500';
    return 'bg-gray-500';
  };

  const tierLabel = (type: string) => {
    if (type === 'named') return { text: 'T1', color: 'text-indigo-400' };
    if (type === 'custom') return { text: 'T2', color: 'text-cyan-400' };
    return { text: 'T3', color: 'text-gray-500' };
  };

  return (
    <aside className="w-64 bg-gray-900 border-r border-gray-800 flex flex-col">
      <div className="p-4 border-b border-gray-800">
        <Link to="/" className="text-xl font-bold text-blue-400 hover:text-blue-300">
          Command Center
        </Link>
        <p className="text-xs text-gray-500 mt-1">Data Orchestrator</p>
      </div>

      <nav className="p-4 flex-1">
        <Link
          to="/"
          className={`block px-3 py-2 rounded text-sm ${
            location.pathname === '/' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
          }`}
        >
          Missions
        </Link>
        <Link
          to="/named-agents"
          className={`block px-3 py-2 rounded text-sm mt-1 ${
            location.pathname === '/named-agents' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
          }`}
        >
          Named Agents
        </Link>
        <Link
          to="/custom-agents"
          className={`block px-3 py-2 rounded text-sm mt-1 ${
            location.pathname === '/custom-agents' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
          }`}
        >
          Custom Agents
        </Link>
        <Link
          to="/stock-agents"
          className={`block px-3 py-2 rounded text-sm mt-1 ${
            location.pathname === '/stock-agents' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
          }`}
        >
          Stock Agents
        </Link>

        <Link
          to="/schedules"
          className={`block px-3 py-2 rounded text-sm mt-1 ${
            location.pathname === '/schedules' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
          }`}
        >
          Schedules
        </Link>

        <div className="mt-4 pt-4 border-t border-gray-800">
          <p className="text-xs text-gray-600 uppercase tracking-wider mb-2 px-3">Pipeline</p>
          <Link
            to="/st-metro"
            className={`block px-3 py-2 rounded text-sm ${
              location.pathname === '/st-metro' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
            }`}
          >
            ST Metro
          </Link>
          <Link
            to="/sky-lynx"
            className={`block px-3 py-2 rounded text-sm ${
              location.pathname === '/sky-lynx' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
            }`}
          >
            Sky-Lynx
          </Link>
        </div>

        <div className="mt-4 pt-4 border-t border-gray-800">
          <p className="text-xs text-gray-600 uppercase tracking-wider mb-2 px-3">Fun</p>
          <Link
            to="/ai-town"
            className={`block px-3 py-2 rounded text-sm ${
              location.pathname === '/ai-town' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
            }`}
          >
            AI Town
          </Link>
        </div>
      </nav>

      <div className="p-4 border-t border-gray-800">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Agents</h3>
        {agents.map((agent) => {
          const tier = tierLabel(agent.type);
          return (
            <div key={agent.id} className="flex items-center gap-2 py-1.5 text-sm">
              <span className={`w-2 h-2 rounded-full ${statusColor(agent.status)}`} />
              <span className="text-gray-300 truncate">{agent.name}</span>
              <span className={`text-xs font-medium ml-auto ${tier.color}`}>{tier.text}</span>
            </div>
          );
        })}
        {agents.length === 0 && (
          <p className="text-xs text-gray-600">No agents registered</p>
        )}
      </div>
    </aside>
  );
}
