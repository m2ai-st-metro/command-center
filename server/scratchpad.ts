import fs from 'fs';
import path from 'path';
import os from 'os';

// The Scratchpad is the ad-hoc report surface: instead of spinning a throwaway
// server on a random port for each artifact, work drops an HTML file here and it
// shows up as a tab entry, served from the dashboard's own origin (no orphan ports).
//
// Storage lives OUTSIDE the repo work-tree on purpose: these are disposable
// artifacts and command-center is under the WIP-snapshot cron + gitleaks, so they
// must not be sweepable into git. Override the locations with env if needed.
export const SCRATCHPAD_DIR =
  process.env.SCRATCHPAD_DIR ?? path.join(os.homedir(), '.command-center', 'scratchpad');
export const ARCHIVE_DIR =
  process.env.SCRATCHPAD_ARCHIVE_DIR ?? path.join(os.homedir(), '.command-center', 'scratchpad-archive');

const EXPIRE_DAYS = parseInt(process.env.SCRATCHPAD_EXPIRE_DAYS ?? '7', 10);
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ScratchpadMeta {
  title?: string;
  task?: string;
  tags?: string[];
  created?: string; // ISO
  pinned?: boolean;
}

export interface ScratchpadEntry {
  slug: string;
  title: string;
  task: string | null;
  tags: string[];
  created: string; // ISO
  pinned: boolean;
  url: string; // same-origin path under /scratchpad-files
  archived: boolean;
}

function ensureDirs(): void {
  fs.mkdirSync(SCRATCHPAD_DIR, { recursive: true });
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}

// Guard against path traversal in slugs that reach mutation endpoints.
function safeSlug(slug: string): string {
  return slug.replace(/[^a-zA-Z0-9._-]/g, '');
}

function listSlugs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name);
}

// The HTML entry inside a slug dir: prefer index.html, else the first *.html.
function entryFile(dir: string): string | null {
  if (fs.existsSync(path.join(dir, 'index.html'))) return 'index.html';
  try {
    return fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith('.html')) ?? null;
  } catch {
    return null;
  }
}

function readMeta(dir: string): ScratchpadMeta {
  const p = path.join(dir, 'meta.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as ScratchpadMeta;
  } catch {
    return {};
  }
}

function writeMeta(dir: string, meta: ScratchpadMeta): void {
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
}

function titleFromHtml(file: string): string | null {
  try {
    const html = fs.readFileSync(file, 'utf8').slice(0, 8192);
    const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function buildEntry(root: string, slug: string, archived: boolean): ScratchpadEntry | null {
  const dir = path.join(root, slug);
  const file = entryFile(dir);
  if (!file) return null;
  const meta = readMeta(dir);
  const stat = fs.statSync(path.join(dir, file));
  const created = meta.created ?? new Date(stat.mtimeMs).toISOString();
  const title = meta.title ?? titleFromHtml(path.join(dir, file)) ?? slug;
  const base = archived ? '/scratchpad-files/_archive' : '/scratchpad-files';
  return {
    slug,
    title,
    task: meta.task ?? null,
    tags: meta.tags ?? [],
    created,
    pinned: meta.pinned ?? false,
    url: `${base}/${encodeURIComponent(slug)}/${file}`,
    archived,
  };
}

function refTimeMs(dir: string, meta: ScratchpadMeta): number {
  if (meta.created) {
    const t = Date.parse(meta.created);
    if (!Number.isNaN(t)) return t;
  }
  const file = entryFile(dir);
  if (file) return fs.statSync(path.join(dir, file)).mtimeMs;
  return Date.now();
}

// Move unpinned entries older than EXPIRE_DAYS into the archive (recoverable,
// not deleted). Runs lazily on each list call so no extra cron is needed.
export function sweepExpired(): string[] {
  ensureDirs();
  const cutoff = Date.now() - EXPIRE_DAYS * DAY_MS;
  const moved: string[] = [];
  for (const slug of listSlugs(SCRATCHPAD_DIR)) {
    const dir = path.join(SCRATCHPAD_DIR, slug);
    const meta = readMeta(dir);
    if (meta.pinned) continue;
    if (refTimeMs(dir, meta) < cutoff) {
      const dest = path.join(ARCHIVE_DIR, slug);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(dir, dest);
      moved.push(slug);
    }
  }
  return moved;
}

export function listEntries(): ScratchpadEntry[] {
  ensureDirs();
  sweepExpired();
  return listSlugs(SCRATCHPAD_DIR)
    .map((slug) => buildEntry(SCRATCHPAD_DIR, slug, false))
    .filter((e): e is ScratchpadEntry => e !== null)
    .sort((a, b) =>
      a.pinned === b.pinned ? b.created.localeCompare(a.created) : a.pinned ? -1 : 1,
    );
}

export function listArchived(): ScratchpadEntry[] {
  ensureDirs();
  return listSlugs(ARCHIVE_DIR)
    .map((slug) => buildEntry(ARCHIVE_DIR, slug, true))
    .filter((e): e is ScratchpadEntry => e !== null)
    .sort((a, b) => b.created.localeCompare(a.created));
}

export function setPinned(slug: string, pinned: boolean): boolean {
  const dir = path.join(SCRATCHPAD_DIR, safeSlug(slug));
  if (!fs.existsSync(dir)) return false;
  const meta = readMeta(dir);
  meta.pinned = pinned;
  writeMeta(dir, meta);
  return true;
}

export function archiveEntry(slug: string): boolean {
  const s = safeSlug(slug);
  const dir = path.join(SCRATCHPAD_DIR, s);
  if (!fs.existsSync(dir)) return false;
  ensureDirs();
  const dest = path.join(ARCHIVE_DIR, s);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(dir, dest);
  return true;
}
