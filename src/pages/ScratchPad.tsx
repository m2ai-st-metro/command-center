import { useEffect, useState, useCallback } from 'react';
import { api, type ScratchpadEntry } from '../api';

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const s = Math.floor((Date.now() - then) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function ScratchPad() {
  const [entries, setEntries] = useState<ScratchpadEntry[]>([]);
  const [archived, setArchived] = useState<ScratchpadEntry[]>([]);
  const [selected, setSelected] = useState<ScratchpadEntry | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listScratchpad()
      .then((d) => {
        setEntries(d.entries);
        setArchived(d.archived);
        setError(null);
        // Keep the current selection if it still exists, else pick the first.
        setSelected((cur) => {
          if (cur && d.entries.some((e) => e.slug === cur.slug)) return cur;
          return d.entries[0] ?? null;
        });
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const togglePin = async (e: ScratchpadEntry) => {
    await api.pinScratchpad(e.slug, !e.pinned);
    load();
  };
  const archive = async (e: ScratchpadEntry) => {
    await api.archiveScratchpad(e.slug);
    if (selected?.slug === e.slug) setSelected(null);
    load();
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">Scratchpad</h1>
          <p className="text-sm text-gray-500">
            Ad-hoc reports and artifacts, in one place. Unpinned entries archive after 7 days.
          </p>
        </div>
        <button
          onClick={load}
          className="px-3 py-1.5 text-sm rounded bg-gray-800 text-gray-300 hover:text-white hover:bg-gray-700"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-3 p-3 rounded bg-red-900/40 border border-red-800 text-red-200 text-sm">
          {error}
        </div>
      )}

      <div className="flex-1 flex gap-4 min-h-0">
        {/* Left: list */}
        <div className="w-80 shrink-0 overflow-auto pr-1">
          {loading && entries.length === 0 ? (
            <p className="text-sm text-gray-600">Loading…</p>
          ) : entries.length === 0 ? (
            <div className="text-sm text-gray-500 space-y-2 p-3 rounded bg-gray-900 border border-gray-800">
              <p className="text-gray-400 font-medium">Nothing on the scratchpad yet.</p>
              <p>Drop an artifact with the helper:</p>
              <code className="block bg-gray-950 rounded p-2 text-xs text-gray-300 whitespace-pre-wrap">
                node scripts/scratchpad-add.mjs --title "My report" report.html
              </code>
              <p>or write <code className="text-gray-400">~/.command-center/scratchpad/&lt;slug&gt;/index.html</code> directly.</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {entries.map((e) => (
                <li
                  key={e.slug}
                  onClick={() => setSelected(e)}
                  className={`p-3 rounded border cursor-pointer transition-colors ${
                    selected?.slug === e.slug
                      ? 'bg-gray-800 border-blue-600'
                      : 'bg-gray-900 border-gray-800 hover:border-gray-700'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <span className="flex-1 text-sm font-medium text-gray-200 truncate">
                      {e.pinned && <span className="text-yellow-400 mr-1">★</span>}
                      {e.title}
                    </span>
                  </div>
                  {e.task && <p className="text-xs text-gray-500 mt-0.5 truncate">{e.task}</p>}
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className="text-xs text-gray-600">{relativeTime(e.created)}</span>
                    {e.tags.map((t) => (
                      <span key={t} className="text-xs px-1.5 rounded bg-gray-800 text-gray-400">
                        {t}
                      </span>
                    ))}
                    <span className="ml-auto flex gap-2">
                      <button
                        onClick={(ev) => { ev.stopPropagation(); togglePin(e); }}
                        className="text-xs text-gray-500 hover:text-yellow-400"
                        title={e.pinned ? 'Unpin' : 'Pin (keep past expiry)'}
                      >
                        {e.pinned ? 'Unpin' : 'Pin'}
                      </button>
                      <button
                        onClick={(ev) => { ev.stopPropagation(); archive(e); }}
                        className="text-xs text-gray-500 hover:text-red-400"
                        title="Move to archive"
                      >
                        Archive
                      </button>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {archived.length > 0 && (
            <div className="mt-4 pt-3 border-t border-gray-800">
              <button
                onClick={() => setShowArchive((s) => !s)}
                className="text-xs text-gray-500 hover:text-gray-300"
              >
                {showArchive ? '▾' : '▸'} Archived ({archived.length})
              </button>
              {showArchive && (
                <ul className="mt-2 space-y-1">
                  {archived.map((e) => (
                    <li key={e.slug} onClick={() => setSelected(e)}
                      className="px-2 py-1 rounded text-xs text-gray-500 hover:bg-gray-900 cursor-pointer truncate">
                      {e.title} <span className="text-gray-700">· {relativeTime(e.created)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Right: preview */}
        <div className="flex-1 min-w-0 rounded border border-gray-800 bg-gray-950 flex flex-col">
          {selected ? (
            <>
              <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
                <span className="text-sm text-gray-300 truncate">
                  {selected.title}
                  {selected.archived && <span className="text-gray-600 ml-2">(archived)</span>}
                </span>
                <a
                  href={selected.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-blue-400 hover:text-blue-300 shrink-0 ml-2"
                >
                  Open in new tab ↗
                </a>
              </div>
              <iframe
                key={selected.url}
                src={selected.url}
                title={selected.title}
                className="flex-1 w-full bg-white rounded-b"
              />
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-gray-600">
              Select an entry to preview it here.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
