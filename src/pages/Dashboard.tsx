import { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

interface Mission {
  id: string;
  goal: string;
  status: string;
  created_at: number;
  updated_at: number;
  duration_ms: number | null;
  agent_id: string | null;
}

interface Classification {
  task_type: string;
  complexity: string;
  suggested_agent: string | null;
  reasoning: string;
  gap?: { detected: boolean; missing: string[]; recommendation: string };
}

interface ProposalResult {
  mission: Mission;
  classification: Classification;
}

export function Dashboard() {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [goal, setGoal] = useState('');
  const [creating, setCreating] = useState(false);
  const [proposal, setProposal] = useState<ProposalResult | null>(null);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadMissions = useCallback(() => {
    api.listMissions().then((data) => setMissions(data.missions as Mission[]));
  }, []);

  useEffect(() => {
    loadMissions();
    const interval = setInterval(loadMissions, 5_000);
    return () => clearInterval(interval);
  }, [loadMissions]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!goal.trim()) return;
    setCreating(true);
    setError(null);
    setProposal(null);
    try {
      const result = await api.createMission(goal.trim()) as ProposalResult;
      setProposal(result);
      setGoal('');
      loadMissions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const handleApprove = async () => {
    if (!proposal) return;
    setApproving(true);
    setError(null);
    try {
      await api.approveMission(proposal.mission.id);
      setProposal(null);
      loadMissions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApproving(false);
    }
  };

  const handleDismiss = () => {
    setProposal(null);
    inputRef.current?.focus();
  };

  const statusBadge = (s: string) => {
    const colors: Record<string, string> = {
      proposed: 'bg-blue-900 text-blue-300',
      approved: 'bg-indigo-900 text-indigo-300',
      running: 'bg-yellow-900 text-yellow-300',
      completed: 'bg-green-900 text-green-300',
      failed: 'bg-red-900 text-red-300',
      cancelled: 'bg-gray-800 text-gray-400',
    };
    return colors[s] || 'bg-gray-800 text-gray-400';
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const active = missions.filter(m => m.status === 'running' || m.status === 'proposed');
  const completed = missions.filter(m => m.status !== 'running' && m.status !== 'proposed');

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold mb-6">Missions</h1>

      {/* Chat-style Mission Input */}
      <div className="mb-8">
        <form onSubmit={handleCreate}>
          <div className="flex gap-3">
            <input
              ref={inputRef}
              type="text"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Tell Data what to do..."
              className="flex-1 px-4 py-3 bg-gray-900 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 text-base"
              disabled={creating}
            />
            <button
              type="submit"
              disabled={creating || !goal.trim()}
              className="px-6 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg font-medium transition-colors"
            >
              {creating ? 'Analyzing...' : 'Send'}
            </button>
          </div>
        </form>

        {error && <p className="mt-2 text-red-400 text-sm">{error}</p>}

        {/* Classification Response Card */}
        {proposal && (
          <div className="mt-3 p-4 bg-gray-900 border border-gray-700 rounded-lg animate-in">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-indigo-900 flex items-center justify-center text-indigo-300 text-xs font-bold shrink-0 mt-0.5">
                D
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-300 mb-2">
                  <span className="text-gray-100 font-medium">{proposal.mission.goal}</span>
                </p>
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <span className="px-2 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">
                    {proposal.classification.task_type}
                  </span>
                  <span className="px-2 py-0.5 bg-gray-800 text-gray-400 rounded text-xs">
                    {proposal.classification.complexity}
                  </span>
                  {proposal.classification.suggested_agent && (
                    <span className="px-2 py-0.5 bg-indigo-900/50 text-indigo-300 rounded text-xs">
                      {proposal.classification.suggested_agent}
                    </span>
                  )}
                </div>

                {proposal.classification.gap?.detected && (
                  <div className="mb-3 px-3 py-2 bg-yellow-900/20 border border-yellow-800/30 rounded text-xs">
                    <span className="text-yellow-400 font-medium">Gap detected: </span>
                    <span className="text-yellow-300/70">
                      missing [{proposal.classification.gap.missing.join(', ')}]
                    </span>
                    {proposal.classification.gap.recommendation && (
                      <p className="text-yellow-300/50 mt-1">{proposal.classification.gap.recommendation}</p>
                    )}
                  </div>
                )}

                <p className="text-xs text-gray-500 mb-3">{proposal.classification.reasoning}</p>

                <div className="flex gap-2">
                  <button
                    onClick={handleApprove}
                    disabled={approving}
                    className="px-4 py-1.5 bg-green-700 hover:bg-green-600 disabled:bg-gray-700 rounded text-sm font-medium transition-colors"
                  >
                    {approving ? 'Launching...' : 'Approve & Launch'}
                  </button>
                  <Link
                    to={`/mission/${proposal.mission.id}`}
                    className="px-4 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-sm font-medium transition-colors"
                  >
                    View Details
                  </Link>
                  <button
                    onClick={handleDismiss}
                    className="px-4 py-1.5 text-gray-500 hover:text-gray-300 text-sm transition-colors"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Active Missions */}
      {active.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Active ({active.length})</h2>
          <div className="space-y-2">
            {active.map((m) => (
              <MissionRow key={m.id} mission={m} statusBadge={statusBadge} formatTime={formatTime} />
            ))}
          </div>
        </section>
      )}

      {/* Completed Missions */}
      {completed.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">History</h2>
          <div className="space-y-2">
            {completed.map((m) => (
              <MissionRow key={m.id} mission={m} statusBadge={statusBadge} formatTime={formatTime} />
            ))}
          </div>
        </section>
      )}

      {missions.length === 0 && !proposal && (
        <div className="text-center py-16">
          <p className="text-lg text-gray-400 mb-2">No missions yet</p>
          <p className="text-sm text-gray-600">Tell Data what to do — type a goal above and hit Send.</p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {[
              'Research the latest trends in AI agents',
              'Write a blog post about our agent architecture',
              'Refactor the mission routing logic',
            ].map((example) => (
              <button
                key={example}
                onClick={() => { setGoal(example); inputRef.current?.focus(); }}
                className="px-3 py-1.5 bg-gray-900 border border-gray-800 rounded-lg text-xs text-gray-400 hover:text-gray-200 hover:border-gray-700 transition-colors"
              >
                {example}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MissionRow({
  mission: m,
  statusBadge,
  formatTime,
}: {
  mission: { id: string; goal: string; status: string; created_at: number; duration_ms: number | null; agent_id: string | null };
  statusBadge: (s: string) => string;
  formatTime: (ts: number) => string;
}) {
  return (
    <Link
      to={`/mission/${m.id}`}
      className="block p-4 bg-gray-900 border border-gray-800 rounded-lg hover:border-gray-700 transition-colors"
    >
      <div className="flex items-center gap-3">
        <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusBadge(m.status)}`}>
          {m.status}
        </span>
        <span className="text-gray-100 flex-1 truncate">{m.goal}</span>
        <span className="text-xs text-gray-500">{formatTime(m.created_at)}</span>
        {m.duration_ms && (
          <span className="text-xs text-gray-500">{Math.round(m.duration_ms / 1000)}s</span>
        )}
        {m.agent_id && (
          <span className="text-xs text-gray-600">{m.agent_id}</span>
        )}
      </div>
    </Link>
  );
}
