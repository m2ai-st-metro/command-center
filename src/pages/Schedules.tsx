import { useEffect, useState, useCallback } from 'react';
import { CronExpressionParser } from 'cron-parser';
import { api } from '../api';

interface Schedule {
  id: string;
  goal: string;
  cron: string;
  cadence_type: 'interval' | 'cron';
  cron_expr: string | null;
  enabled: boolean;
  last_run_at: number | null;
  next_run_at: number | null;
  last_mission_id: string | null;
  created_at: number;
}

const INTERVAL_PRESETS = [
  { label: '5 min', value: '5m' },
  { label: '30 min', value: '30m' },
  { label: '1 hour', value: '1h' },
  { label: '6 hours', value: '6h' },
  { label: '24 hours', value: '24h' },
  { label: '7 days', value: '7d' },
];

const CRON_PRESETS = [
  { label: 'Daily 9am', value: '0 9 * * *' },
  { label: 'Weekly Mon 9am', value: '0 9 * * 1' },
  { label: 'Weekdays 8am', value: '0 8 * * 1-5' },
  { label: 'Every 4h', value: '0 */4 * * *' },
];

function getNextCronRuns(expr: string, count = 3): Date[] | null {
  try {
    const parsed = CronExpressionParser.parse(expr);
    const runs: Date[] = [];
    for (let i = 0; i < count; i++) runs.push(parsed.next().toDate());
    return runs;
  } catch {
    return null;
  }
}

export function Schedules() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [creating, setCreating] = useState(false);
  const [goal, setGoal] = useState('');
  const [cadenceType, setCadenceType] = useState<'interval' | 'cron'>('interval');
  const [interval, setInterval_] = useState('1h');
  const [cronExpr, setCronExpr] = useState('0 9 * * *');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<Record<string, boolean>>({});

  const load = useCallback(() => {
    api.listSchedules().then(data => setSchedules(data.schedules as Schedule[]));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!goal.trim()) return;
    setSaving(true);
    setError(null);
    try {
      if (cadenceType === 'cron') {
        await api.createSchedule(goal.trim(), undefined, cronExpr.trim());
      } else {
        await api.createSchedule(goal.trim(), interval.trim(), undefined);
      }
      setGoal('');
      setCreating(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    await api.updateSchedule(id, { enabled: !enabled });
    load();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this schedule?')) return;
    await api.deleteSchedule(id);
    load();
  };

  const handleRunNow = async (id: string) => {
    setRunning(prev => ({ ...prev, [id]: true }));
    try {
      const res = await fetch(`/api/schedules/${id}/run`, { method: 'POST' });
      const data = await res.json() as { mission_id?: string; error?: string };
      if (!res.ok) throw new Error(data.error || res.statusText);
      setError(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(prev => ({ ...prev, [id]: false }));
    }
  };

  const formatTime = (ts: number | null) => {
    if (!ts) return '—';
    const d = new Date(ts * 1000);
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const timeUntil = (ts: number | null) => {
    if (!ts) return '';
    const diff = ts * 1000 - Date.now();
    if (diff <= 0) return 'due now';
    const mins = Math.floor(diff / 60_000);
    if (mins < 60) return `in ${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `in ${hrs}h ${mins % 60}m`;
    const days = Math.floor(hrs / 24);
    return `in ${days}d ${hrs % 24}h`;
  };

  // Derive Next 3 runs for cron preview in the form
  const cronPreviewRuns = cadenceType === 'cron' ? getNextCronRuns(cronExpr) : null;

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Schedules</h1>
          <p className="text-sm text-gray-500 mt-1">Recurring missions on a timer.</p>
        </div>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg font-medium transition-colors"
          >
            + New Schedule
          </button>
        )}
      </div>

      {error && <p className="mb-4 text-red-400 text-sm">{error}</p>}

      {creating && (
        <form onSubmit={handleCreate} className="mb-6 p-4 bg-gray-900 border border-gray-700 rounded-lg">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">New Schedule</h2>
            <button type="button" onClick={() => setCreating(false)} className="text-sm text-gray-500 hover:text-gray-300">Cancel</button>
          </div>
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Mission Goal</label>
              <input
                type="text"
                value={goal}
                onChange={e => setGoal(e.target.value)}
                placeholder="e.g. Check deployment health and report issues"
                className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
            </div>

            {/* Cadence type radio */}
            <div>
              <label className="block text-sm text-gray-400 mb-2">Cadence</label>
              <div className="flex gap-4 mb-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    value="interval"
                    checked={cadenceType === 'interval'}
                    onChange={() => setCadenceType('interval')}
                    className="accent-blue-500"
                  />
                  <span className="text-sm text-gray-300">Interval</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    value="cron"
                    checked={cadenceType === 'cron'}
                    onChange={() => setCadenceType('cron')}
                    className="accent-blue-500"
                  />
                  <span className="text-sm text-gray-300">Cron</span>
                </label>
              </div>

              {cadenceType === 'interval' ? (
                <>
                  <div className="flex flex-wrap gap-2 mb-2">
                    {INTERVAL_PRESETS.map(p => (
                      <button
                        key={p.value}
                        type="button"
                        onClick={() => setInterval_(p.value)}
                        className={`px-3 py-1 rounded text-sm transition-colors ${
                          interval === p.value ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <input
                    type="text"
                    value={interval}
                    onChange={e => setInterval_(e.target.value)}
                    placeholder="Custom: 15m, 2h, 3d"
                    className="w-48 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                </>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2 mb-2">
                    {CRON_PRESETS.map(p => (
                      <button
                        key={p.value}
                        type="button"
                        onClick={() => setCronExpr(p.value)}
                        className={`px-3 py-1 rounded text-sm transition-colors ${
                          cronExpr === p.value ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <input
                    type="text"
                    value={cronExpr}
                    onChange={e => setCronExpr(e.target.value)}
                    placeholder="0 9 * * * (min hr dom mon dow)"
                    className="w-64 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
                  />
                  {cronPreviewRuns ? (
                    <div className="mt-2 text-xs text-gray-500">
                      Next 3 runs:
                      {cronPreviewRuns.map((d, i) => (
                        <span key={i} className="ml-2 text-gray-400">{d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-1 text-xs text-red-400">Invalid cron expression</p>
                  )}
                </>
              )}
            </div>

            <button
              type="submit"
              disabled={saving || !goal.trim() || (cadenceType === 'cron' && !cronPreviewRuns)}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg font-medium transition-colors"
            >
              {saving ? 'Creating...' : 'Create Schedule'}
            </button>
          </div>
        </form>
      )}

      {schedules.length === 0 && !creating ? (
        <div className="text-center py-16 text-gray-500">
          <p className="text-lg mb-2">No schedules yet</p>
          <p className="text-sm">Create a schedule to run missions automatically on a timer.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {schedules.map(s => (
            <div
              key={s.id}
              className={`p-4 bg-gray-900 border rounded-lg transition-colors ${
                s.enabled ? 'border-gray-800' : 'border-gray-800/50 opacity-60'
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`w-2 h-2 rounded-full ${s.enabled ? 'bg-green-500' : 'bg-gray-600'}`} />
                    <span className="text-gray-100 font-medium">{s.goal}</span>
                  </div>
                  <div className="flex flex-wrap gap-3 text-xs text-gray-500">
                    <span>
                      {s.cadence_type === 'cron' ? 'Cron' : 'Every'}{' '}
                      <span className="text-gray-300 font-mono">{s.cadence_type === 'cron' ? s.cron_expr ?? s.cron : s.cron}</span>
                    </span>
                    {s.next_run_at && s.enabled && (
                      <span>Next: <span className="text-gray-300">{timeUntil(s.next_run_at)}</span></span>
                    )}
                    {s.last_run_at && (
                      <span>Last: <span className="text-gray-400">{formatTime(s.last_run_at)}</span></span>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => handleRunNow(s.id)}
                    disabled={running[s.id]}
                    className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-blue-900 text-gray-400 hover:text-blue-300 disabled:opacity-50 rounded transition-colors"
                  >
                    {running[s.id] ? 'Running...' : 'Run Now'}
                  </button>
                  <button
                    onClick={() => handleToggle(s.id, s.enabled)}
                    className={`px-3 py-1.5 text-sm rounded transition-colors ${
                      s.enabled
                        ? 'bg-gray-800 hover:bg-yellow-900 text-gray-400 hover:text-yellow-300'
                        : 'bg-gray-800 hover:bg-green-900 text-gray-400 hover:text-green-300'
                    }`}
                  >
                    {s.enabled ? 'Pause' : 'Resume'}
                  </button>
                  <button
                    onClick={() => handleDelete(s.id)}
                    className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-red-900 text-gray-400 hover:text-red-300 rounded transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
