#!/usr/bin/env node
/**
 * Migrate / rename a klaudban user id.
 *
 * Usage:
 *   node scripts/migrate-user-id.mjs <fromId> <toId> [--dry-run] [--yes]
 *   npm run user:migrate -- <fromId> <toId> --dry-run
 *
 * Behavior:
 * - Rewrites task frontmatter `assignee: <from>` → `<to>` under vault.tasksDir
 * - Updates klaudban.config.json users[]:
 *   - target missing → rename source entry to target id
 *   - target exists  → merge providers (union), merge label/emoji, delete source
 * - Label rule: keep target label unless it is empty or equals the id
 * - Requires --yes to write (or only --dry-run to preview)
 *
 * Paths: reads klaudban.config.json from process.cwd() (or --cwd).
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

function usage(code = 1) {
  console.error(`Usage: node scripts/migrate-user-id.mjs <fromId> <toId> [--dry-run] [--yes] [--cwd <dir>]

Examples:
  npm run user:migrate -- alice alice@tensorfleet.net --dry-run
  npm run user:migrate -- alice alice@tensorfleet.net --yes
`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { dryRun: false, yes: false, cwd: process.cwd(), positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--yes' || a === '-y') args.yes = true;
    else if (a === '--cwd') args.cwd = resolve(argv[++i] || '');
    else if (a === '-h' || a === '--help') usage(0);
    else if (a.startsWith('-')) {
      console.error(`Unknown flag: ${a}`);
      usage(1);
    } else args.positional.push(a);
  }
  return args;
}

function normId(id) {
  return String(id || '').trim().toLowerCase();
}

function normalizeProviders(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const p = String(raw || '').trim().toLowerCase();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function isPlaceholderLabel(user) {
  if (!user) return true;
  const label = String(user.label || '').trim();
  if (!label) return true;
  const id = String(user.id || '').trim().toLowerCase();
  // Only when label is literally the id (or empty). "Levi" for levi@x is fine.
  return label.toLowerCase() === id;
}

function walkMdFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkMdFiles(p, out);
    else if (st.isFile() && name.endsWith('.md')) out.push(p);
  }
  return out;
}

function splitFrontmatter(raw) {
  if (!raw.startsWith('---')) return null;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return null;
  const fmRaw = raw.slice(3, end).replace(/^\n/, '');
  const body = raw.slice(end + 4).replace(/^\n/, '');
  return { fmRaw, body };
}

function loadConfig(cwd) {
  const path = resolve(cwd, 'klaudban.config.json');
  if (!existsSync(path)) {
    throw new Error(`klaudban.config.json not found in ${cwd}`);
  }
  const data = JSON.parse(readFileSync(path, 'utf8'));
  return { path, data };
}

function tasksDirFromConfig(cwd, data) {
  const rel = data?.vault?.tasksDir || './vault/tasks';
  return resolve(cwd, rel);
}

function mergeUsers(source, target, toId) {
  const srcProviders = normalizeProviders(source?.providers);
  const tgtProviders = normalizeProviders(target?.providers);
  const providers = normalizeProviders([...tgtProviders, ...srcProviders]);

  let label = (target?.label && String(target.label).trim()) || toId;
  if (isPlaceholderLabel(target) && source?.label && String(source.label).trim()) {
    label = String(source.label).trim();
  }

  const emoji = target?.emoji || source?.emoji || '👤';

  return {
    id: toId,
    label,
    emoji,
    providers,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.positional.length !== 2) usage(1);

  const fromId = normId(args.positional[0]);
  const toId = normId(args.positional[1]);
  if (!fromId || !toId) usage(1);
  if (fromId === toId) {
    console.log('from and to are the same; nothing to do.');
    process.exit(0);
  }
  if (!args.dryRun && !args.yes) {
    console.error('Refusing to write without --yes (or pass --dry-run).');
    process.exit(2);
  }

  const { path: configPath, data } = loadConfig(args.cwd);
  const tasksDir = tasksDirFromConfig(args.cwd, data);
  const users = Array.isArray(data.users)
    ? data.users.map((u) => ({ ...u, id: normId(u.id) }))
    : [];

  const source = users.find((u) => u.id === fromId) || null;
  const target = users.find((u) => u.id === toId) || null;

  if (!source && !target) {
    console.warn(
      `Warning: neither "${fromId}" nor "${toId}" is in users[]; will only rewrite task assignees.`,
    );
  } else if (!source) {
    console.warn(
      `Warning: source "${fromId}" not in users[]; will only rewrite assignees + leave target as-is.`,
    );
  }

  let nextUsers = users.slice();
  let userAction = 'none';
  if (source && !target) {
    nextUsers = users.map((u) =>
      u.id === fromId
        ? { ...u, id: toId, providers: normalizeProviders(u.providers) }
        : u,
    );
    userAction = 'rename';
  } else if (source && target) {
    const merged = mergeUsers(source, target, toId);
    nextUsers = users.filter((u) => u.id !== fromId && u.id !== toId).concat([merged]);
    userAction = 'merge';
  } else {
    userAction = 'assignees-only';
  }

  const files = walkMdFiles(tasksDir);
  const taskChanges = [];
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const parts = splitFrontmatter(raw);
    if (!parts) continue;
    let fm;
    try {
      fm = yaml.load(parts.fmRaw) || {};
    } catch {
      continue;
    }
    if (typeof fm !== 'object' || fm === null) continue;
    const cur = fm.assignee != null ? normId(String(fm.assignee)) : '';
    if (cur !== fromId) continue;

    fm.assignee = toId;
    const yamlStr = yaml.dump(fm, { lineWidth: 100 }).trim();
    let body = parts.body || '';
    if (body && !body.startsWith('\n')) body = '\n' + body;
    let finalRaw = `---\n${yamlStr}\n---\n${body}`;
    if (!finalRaw.endsWith('\n')) finalRaw += '\n';
    taskChanges.push({
      file,
      rel: relative(args.cwd, file),
      from: fromId,
      to: toId,
      nextRaw: finalRaw,
    });
  }

  console.log(
    JSON.stringify(
      {
        dryRun: args.dryRun,
        cwd: args.cwd,
        configPath,
        tasksDir,
        fromId,
        toId,
        userAction,
        sourceUser: source,
        targetUser: target,
        nextUserEntry:
          userAction === 'rename' || userAction === 'merge'
            ? nextUsers.find((u) => u.id === toId)
            : target,
        taskFilesToRewrite: taskChanges.length,
        tasks: taskChanges.map((t) => t.rel),
      },
      null,
      2,
    ),
  );

  if (args.dryRun) {
    console.log('\nDry run only — no files written.');
    return;
  }

  for (const t of taskChanges) {
    writeFileSync(t.file, t.nextRaw, 'utf8');
  }

  if (userAction === 'rename' || userAction === 'merge') {
    data.users = nextUsers;
    writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }

  console.log(`\nWrote ${taskChanges.length} task file(s); users action=${userAction}.`);
}

try {
  main();
} catch (err) {
  console.error(err?.message || err);
  process.exit(1);
}
