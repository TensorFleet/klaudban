#!/usr/bin/env node
/**
 * Migrate / rename a klaudban user id.
 *
 * Usage:
 *   node scripts/migrate-user-id.mjs <fromId> <toId> [--dry-run] [--yes] [--force]
 *   npm run user:migrate -- <fromId> <toId> --dry-run
 *
 * Behavior:
 * - Rewrites task frontmatter `assignee: <from>` → `<to>` under vault.tasksDir
 * - Updates klaudban.config.json users[]:
 *   - target missing → rename source entry to target id
 *   - target exists  → merge providers (union), merge label/emoji, delete source
 * - Label rule: keep target label unless empty or equals the id (not email local-part)
 * - Requires --yes to write (or only --dry-run to preview)
 * - YAML load/dump uses CORE_SCHEMA so dates stay strings
 * - Parse failures are reported; --yes fails unless --force
 *
 * Paths: reads klaudban.config.json from process.cwd() (or --cwd).
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

/** Keep scalars as strings (no Date objects for due:/date:). */
const YAML_OPTS = { schema: yaml.CORE_SCHEMA, lineWidth: 100 };

function usage(code = 1) {
  console.error(`Usage: node scripts/migrate-user-id.mjs <fromId> <toId> [--dry-run] [--yes] [--force] [--cwd <dir>]

Examples:
  npm run user:migrate -- alice alice@tensorfleet.net --dry-run
  npm run user:migrate -- alice alice@tensorfleet.net --yes
`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    yes: false,
    force: false,
    cwd: process.cwd(),
    positional: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--yes' || a === '-y') args.yes = true;
    else if (a === '--force') args.force = true;
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

/** Collapse case-duplicate ids; later entries merge providers into the first. */
function dedupeUsers(list) {
  const byId = new Map();
  for (const u of list) {
    if (!u?.id) continue;
    const id = normId(u.id);
    if (!id) continue;
    const providers = normalizeProviders(u.providers);
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        label: (u.label && String(u.label).trim()) || id,
        emoji: u.emoji || '👤',
        providers,
      });
    } else {
      const cur = byId.get(id);
      cur.providers = normalizeProviders([...cur.providers, ...providers]);
      if (isPlaceholderLabel(cur) && u.label && String(u.label).trim()) {
        cur.label = String(u.label).trim();
      }
      if (!cur.emoji && u.emoji) cur.emoji = u.emoji;
    }
  }
  return [...byId.values()];
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
  const users = dedupeUsers(Array.isArray(data.users) ? data.users : []);

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
    nextUsers = dedupeUsers(
      users.map((u) =>
        u.id === fromId
          ? { ...u, id: toId, providers: normalizeProviders(u.providers) }
          : u,
      ),
    );
    userAction = 'rename';
  } else if (source && target) {
    const merged = mergeUsers(source, target, toId);
    nextUsers = dedupeUsers(
      users.filter((u) => u.id !== fromId && u.id !== toId).concat([merged]),
    );
    userAction = 'merge';
  } else {
    userAction = 'assignees-only';
    nextUsers = users;
  }

  const files = walkMdFiles(tasksDir);
  const taskChanges = [];
  const skipped = [];
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const rel = relative(args.cwd, file);
    if (!raw.startsWith('---')) {
      // no frontmatter — ignore
      continue;
    }
    const parts = splitFrontmatter(raw);
    if (!parts) {
      skipped.push({ rel, reason: 'malformed frontmatter fence' });
      continue;
    }
    let fm;
    try {
      fm = yaml.load(parts.fmRaw, YAML_OPTS) || {};
    } catch (err) {
      skipped.push({ rel, reason: `yaml parse: ${err.message || err}` });
      continue;
    }
    if (typeof fm !== 'object' || fm === null || Array.isArray(fm)) {
      skipped.push({ rel, reason: 'frontmatter is not a mapping' });
      continue;
    }
    const cur = fm.assignee != null ? normId(String(fm.assignee)) : '';
    if (cur !== fromId) continue;

    fm.assignee = toId;
    const yamlStr = yaml.dump(fm, YAML_OPTS).trim();
    let body = parts.body || '';
    if (body && !body.startsWith('\n')) body = '\n' + body;
    let finalRaw = `---\n${yamlStr}\n---\n${body}`;
    if (!finalRaw.endsWith('\n')) finalRaw += '\n';
    taskChanges.push({
      file,
      rel,
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
        skippedFiles: skipped,
      },
      null,
      2,
    ),
  );

  if (skipped.length) {
    console.warn(`\nWarning: skipped ${skipped.length} task file(s) (see skippedFiles).`);
  }

  if (args.dryRun) {
    console.log('\nDry run only — no files written.');
    return;
  }

  if (skipped.length && !args.force) {
    console.error(
      'Aborting write because some task files were skipped. Re-run with --force to apply partial migrate, or fix those files first.',
    );
    process.exit(3);
  }

  for (const t of taskChanges) {
    writeFileSync(t.file, t.nextRaw, 'utf8');
  }

  if (userAction === 'rename' || userAction === 'merge' || userAction === 'assignees-only') {
    // Always write deduped users when we touched config path for rename/merge;
    // assignees-only still rewrite tasks only unless we want to persist dedupe —
    // persist dedupe on any successful --yes for consistency when rename/merge.
    if (userAction === 'rename' || userAction === 'merge') {
      data.users = nextUsers;
      writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    }
  }

  console.log(`\nWrote ${taskChanges.length} task file(s); users action=${userAction}.`);
  if (skipped.length) {
    console.warn(`Skipped ${skipped.length} file(s) (--force).`);
  }
}

try {
  main();
} catch (err) {
  console.error(err?.message || err);
  process.exit(1);
}
