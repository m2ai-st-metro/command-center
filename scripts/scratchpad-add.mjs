#!/usr/bin/env node
// scratchpad-add.mjs — drop an HTML artifact onto the CCOS Scratchpad.
//
// Instead of spinning a throwaway server on a random port, write the artifact
// here; it appears as a tab entry served from the dashboard's own origin.
//
// Usage:
//   node scripts/scratchpad-add.mjs --title "My Report" [--task "..."] [--tags a,b] report.html
//   cat report.html | node scripts/scratchpad-add.mjs --title "My Report"   # from stdin
//
// Env: SCRATCHPAD_DIR overrides the storage dir (default ~/.command-center/scratchpad).

import fs from 'fs';
import path from 'path';
import os from 'os';

const SCRATCHPAD_DIR =
  process.env.SCRATCHPAD_DIR ?? path.join(os.homedir(), '.command-center', 'scratchpad');
const PORT = process.env.COMMAND_CENTER_PORT ?? '3142';
const LAN_HOST = process.env.CC_LAN_HOST ?? '10.0.0.46';

function parseArgs(argv) {
  const out = { title: null, task: null, tags: [], file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--title') out.title = argv[++i];
    else if (a === '--task') out.task = argv[++i];
    else if (a === '--tags') out.tags = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (!a.startsWith('--')) out.file = a;
  }
  return out;
}

function slugify(s) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  );
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const args = parseArgs(process.argv.slice(2));
const html = args.file ? fs.readFileSync(args.file, 'utf8') : readStdin();

if (!html.trim()) {
  console.error('No HTML provided (pass a file or pipe via stdin).');
  process.exit(2);
}

const title = args.title ?? (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? 'Untitled');
// Unique slug: title slug + short time suffix so repeated titles do not collide.
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const slug = `${slugify(title)}-${stamp.slice(11)}`;
const dir = path.join(SCRATCHPAD_DIR, slug);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'index.html'), html);
fs.writeFileSync(
  path.join(dir, 'meta.json'),
  JSON.stringify(
    { title, task: args.task ?? undefined, tags: args.tags, created: new Date().toISOString(), pinned: false },
    null,
    2,
  ),
);

console.log(`Added to Scratchpad: ${title}`);
console.log(`  Tab:      http://${LAN_HOST}:${PORT}/scratchpad`);
console.log(`  Direct:   http://${LAN_HOST}:${PORT}/scratchpad-files/${encodeURIComponent(slug)}/index.html`);
