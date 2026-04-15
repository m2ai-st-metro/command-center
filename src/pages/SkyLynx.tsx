import { useEffect, useMemo, useState, useCallback } from 'react';

interface Proposal {
  id: number;
  parameter: string;
  current_value: string;
  proposed_value: string;
  rationale: string;
  source: string;
  status: 'proposed' | 'accepted' | 'rejected' | 'escalated';
  proposed_at: string;
  resolved_at: string | null;
  squawk_count: number;
  repeat_count: number;
}

interface JsonRec {
  filename: string;
  source?: string;
  created_at?: string;
  target_system?: string;
  title?: string;
  priority?: string;
  evidence?: string;
  recommendation_type?: string;
}

interface SkyLynxData {
  warning?: string;
  proposal_count: number;
  status_counts: Record<string, number>;
  acceptance_rate: number | null;
  proposals: Proposal[];
  json_recs: JsonRec[];
}

const EMPTY: SkyLynxData = {
  proposal_count: 0,
  status_counts: {},
  acceptance_rate: null,
  proposals: [],
  json_recs: [],
};

const STATUS_CLASS: Record<string, string> = {
  proposed: 'text-gray-300',
  accepted: 'text-emerald-400',
  rejected: 'text-red-400',
  escalated: 'text-yellow-400',
};

function KpiCard({ label, value, accent }: { label: string; value: string | number; accent?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex flex-col gap-1">
      <span className={`text-2xl font-bold ${accent ?? 'text-white'}`}>{value}</span>
      <span className="text-xs text-gray-500 uppercase tracking-wider">{label}</span>
    </div>
  );
}

export function SkyLynx() {
  const [data, setData] = useState<SkyLynxData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [minRepeats, setMinRepeats] = useState<number>(1);

  const load = useCallback(() => {
    fetch('/api/sky-lynx/recs')
      .then((r) => r.json())
      .then((d: SkyLynxData) => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const filtered = useMemo(
    () =>
      data.proposals.filter(
        (p) =>
          (statusFilter === 'all' || p.status === statusFilter) &&
          p.repeat_count >= minRepeats
      ),
    [data.proposals, statusFilter, minRepeats]
  );

  const acceptancePct =
    data.acceptance_rate !== null ? `${(data.acceptance_rate * 100).toFixed(0)}%` : '--';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Sky-Lynx Recommends</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Phase 1: read-only view of Sky-Lynx parameter proposals and recommendations
          </p>
        </div>
        {loading && <span className="text-xs text-gray-600 animate-pulse">Loading...</span>}
      </div>

      {data.warning && (
        <div className="bg-yellow-900/40 border border-yellow-700 text-yellow-300 rounded-lg px-4 py-3 text-sm">
          {data.warning}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="Proposals" value={data.proposal_count} />
        <KpiCard label="Accepted" value={data.status_counts.accepted ?? 0} accent="text-emerald-400" />
        <KpiCard label="Rejected" value={data.status_counts.rejected ?? 0} accent="text-red-400" />
        <KpiCard label="Acceptance Rate" value={acceptancePct} accent="text-blue-400" />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4 bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500 uppercase tracking-wider">Status</label>
          <select
            className="bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded px-2 py-1"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">All</option>
            <option value="proposed">Proposed</option>
            <option value="accepted">Accepted</option>
            <option value="rejected">Rejected</option>
            <option value="escalated">Escalated</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500 uppercase tracking-wider">Min Repeats</label>
          <input
            type="number"
            min={1}
            className="bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded px-2 py-1 w-20"
            value={minRepeats}
            onChange={(e) => setMinRepeats(Math.max(1, parseInt(e.target.value) || 1))}
          />
        </div>
        <span className="ml-auto text-xs text-gray-600">
          Showing {filtered.length} / {data.proposals.length}
        </span>
      </div>

      {/* Proposals table */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
          Parameter Proposals
        </h2>
        {filtered.length === 0 ? (
          <p className="text-sm text-gray-600">No proposals match the current filters.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-600 uppercase">
                <th className="text-left pb-2 font-medium">Parameter</th>
                <th className="text-left pb-2 font-medium">Current → Proposed</th>
                <th className="text-left pb-2 font-medium">Status</th>
                <th className="text-right pb-2 font-medium">Repeats</th>
                <th className="text-right pb-2 font-medium">Proposed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {filtered.map((p) => (
                <tr key={p.id} className="hover:bg-gray-800/50" title={p.rationale}>
                  <td className="py-2 pr-4 text-gray-200 font-mono text-xs">{p.parameter}</td>
                  <td className="py-2 pr-4 text-gray-400 font-mono text-xs">
                    {p.current_value} → <span className="text-blue-300">{p.proposed_value}</span>
                  </td>
                  <td className={`py-2 pr-4 text-xs capitalize ${STATUS_CLASS[p.status] ?? 'text-gray-400'}`}>
                    {p.status}
                  </td>
                  <td className="py-2 pr-4 text-right text-gray-400">{p.repeat_count}</td>
                  <td className="py-2 text-right text-xs text-gray-600">
                    {p.proposed_at.slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* JSON recs (recent free-form) */}
      {data.json_recs.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
            Recent Recommendations (free-form)
          </h2>
          <div className="space-y-2">
            {data.json_recs.slice(0, 10).map((r) => (
              <div key={r.filename} className="flex items-baseline gap-3 text-sm">
                <span className="text-xs text-gray-600 w-20 shrink-0">
                  {r.created_at?.slice(0, 10) ?? '--'}
                </span>
                <span className="text-xs text-gray-500 w-20 shrink-0 capitalize">
                  {r.target_system ?? '--'}
                </span>
                <span className="text-gray-300">{r.title ?? r.filename}</span>
                {r.priority && (
                  <span className="text-xs text-gray-600 ml-auto capitalize">{r.priority}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
