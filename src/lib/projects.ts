/**
 * Projects: vault → CRUD.
 *
 * Source: `<projectsDir>/<categoryKey>/*.md` where `projectsDir` and the
 * available category keys both come from `klaudban.config.json` (see
 * `config.ts` for defaults). Each file is a project doc with frontmatter
 * whose shape depends on which category's `fields` it belongs to.
 *
 * This module exposes `listAll / getOne / createProject / updateProject /
 * deleteProject` for the projects view. `tasks.ts` keeps its own
 * `listProjects()` returning just slugs — that's what the task modal dropdown
 * needs.
 *
 * `days_since_touched` is derived from the file's `mtime`. Syncthing /
 * Dropbox / iCloud all update mtime on incoming changes, so it reflects real
 * edits from any device, not just local writes.
 */
import { readdirSync, readFileSync, writeFileSync, unlinkSync, mkdirSync,
         existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { marked } from 'marked';
import { listAll as listAllTasks, CARD_COLORS, type CardColor } from './tasks';
import {
  CONFIG, VAULT_PROJECTS,
  CATEGORY_KEYS, CATEGORY_LABEL, CATEGORY_TYPE, CATEGORY_FIELDS, CATEGORY_EMOJI,
} from './config';

// Category is just a string — the runtime set comes from CONFIG.projects.categories.
export type Category = string;
export const CATEGORIES: Category[] = CATEGORY_KEYS;
export { CATEGORY_LABEL, CATEGORY_TYPE, CATEGORY_FIELDS, CATEGORY_EMOJI };

function isKnownCategory(c: string): boolean {
  return CATEGORY_KEYS.includes(c);
}

export interface Project {
  file: string;              // filename SIN .md (slug)
  category: Category;
  title: string;             // primer H1 o slug
  frontmatter: Record<string, unknown>;
  body: string;              // markdown sin frontmatter
  body_html: string;
  mtime: number;             // ms epoch
  days_since_touched: number;
  tasks_open: number;        // active tasks (pending/doing/blocked) pointing at this project
  tasks_done: number;        // done tasks pointing at this project
}

const FRONT_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function todayLocal(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: CONFIG.ui.timezone });
}

function sanitizeSlug(name: string): string {
  return name.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// Render markdown con soporte de embeds Obsidian (mismo patrón que tasks.ts).
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
function resolveObsidianEmbeds(md: string): string {
  return md
    .replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, name, alt) => {
      const fn = String(name).trim();
      const altText = (alt ?? fn).trim().replace(/"/g, '&quot;');
      if (IMG_EXT.test(fn)) return `<img src="/api/embed?file=${encodeURIComponent(fn)}" alt="${altText}" loading="lazy" />`;
      return `<span class="wikilink">📄 ${fn.replace(/"/g, '&quot;')}</span>`;
    })
    .replace(/(^|[^!])\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, prev, name, alt) => {
      const display = (alt ?? name).trim().replace(/[<>]/g, '');
      return `${prev}<span class="wikilink">🔗 ${display}</span>`;
    });
}

function renderBody(md: string): string {
  marked.setOptions({ gfm: true, breaks: false });
  return marked.parse(resolveObsidianEmbeds(md), { async: false }) as string;
}

function daysSince(mtime: number): number {
  return Math.floor((Date.now() - mtime) / 86_400_000);
}

function parseFile(category: Category, filename: string): Project | null {
  const fullPath = join(VAULT_PROJECTS, category, filename);
  let raw: string;
  let mtime = 0;
  try {
    raw = readFileSync(fullPath, 'utf8');
    mtime = statSync(fullPath).mtimeMs;
  } catch { return null; }

  const m = raw.match(FRONT_RE);
  let frontmatter: Record<string, unknown> = {};
  let body = raw;
  if (m) {
    try { frontmatter = (yaml.load(m[1]) as Record<string, unknown>) ?? {}; }
    catch { frontmatter = {}; }
    body = m[2];
  }

  const noExt = filename.replace(/\.md$/, '');
  const h1 = body.match(/^#\s+(.+)$/m);
  const title = h1 ? h1[1].trim() : noExt;

  return {
    file: noExt,
    category,
    title,
    frontmatter,
    body,
    body_html: renderBody(body),
    mtime,
    days_since_touched: daysSince(mtime),
    tasks_open: 0,  // se llena en listAll() — getOne() también lo recalcula
    tasks_done: 0,
  };
}

// Counts tasks per project (slug = filename without .md, same as the
// `project:` frontmatter field on tasks). Returns { slug → { open, done } }.
function countTasksByProject(): Record<string, { open: number; done: number }> {
  const counts: Record<string, { open: number; done: number }> = {};
  for (const t of listAllTasks()) {
    const slug = t.project;
    if (!slug) continue;
    counts[slug] ??= { open: 0, done: 0 };
    if (t.status === 'done') counts[slug].done++;
    else counts[slug].open++;
  }
  return counts;
}

// ── List ─────────────────────────────────────────────────────────────────

export function listAll(): Project[] {
  const out: Project[] = [];
  for (const cat of CATEGORIES) {
    const dir = join(VAULT_PROJECTS, cat);
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.md')) continue;
      if (f.startsWith('.') || f.startsWith('._')) continue;
      const p = parseFile(cat, f);
      if (p) out.push(p);
    }
  }
  const counts = countTasksByProject();
  for (const p of out) {
    const c = counts[p.file];
    if (c) { p.tasks_open = c.open; p.tasks_done = c.done; }
  }
  // Newest first
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Mapa { slug → color } para proyectos que tengan `color: <name>` en su
 * frontmatter. Lo consume el board (index.astro) para que las cards
 * sin color propio hereden el del proyecto. Slug = filename sin .md
 * (mismo identificador que el campo `project:` de las tareas).
 */
export function listProjectColors(): Record<string, CardColor> {
  const out: Record<string, CardColor> = {};
  for (const cat of CATEGORIES) {
    const dir = join(VAULT_PROJECTS, cat);
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.md')) continue;
      if (f.startsWith('.') || f.startsWith('._')) continue;
      const p = parseFile(cat, f);
      if (!p) continue;
      const raw = p.frontmatter.color;
      if (typeof raw === 'string' && (CARD_COLORS as readonly string[]).includes(raw.toLowerCase())) {
        out[p.file] = raw.toLowerCase() as CardColor;
      }
    }
  }
  return out;
}

export function getOne(file: string): Project | null {
  const filename = file.endsWith('.md') ? file : file + '.md';
  for (const cat of CATEGORIES) {
    const fullPath = join(VAULT_PROJECTS, cat, filename);
    if (existsSync(fullPath)) {
      const p = parseFile(cat, filename);
      if (!p) return null;
      const c = countTasksByProject()[p.file];
      if (c) { p.tasks_open = c.open; p.tasks_done = c.done; }
      return p;
    }
  }
  return null;
}

// ── Create ───────────────────────────────────────────────────────────────

export interface ProjectCreateInput {
  name: string;        // título humano, se convierte a slug
  category: Category;
  slug?: string;       // opcional, si quieres controlar el filename
}

function defaultFrontmatterFor(category: Category, today: string): Record<string, unknown> {
  // Sembramos el frontmatter con `type` y `updated`, más una entrada vacía por
  // cada campo declarado en CONFIG.projects.categories[].fields. El usuario
  // The user fills them in the project editor modal.
  const base: Record<string, unknown> = {
    type: CATEGORY_TYPE[category],
    updated: today,
  };
  for (const f of CATEGORY_FIELDS[category] ?? []) {
    if (f === 'type' || f === 'updated') continue;
    if (!(f in base)) base[f] = '';
  }
  return base;
}

export function createProject(input: ProjectCreateInput): Project {
  if (!input.name?.trim()) throw new Error('name requerido');
  const slug = input.slug ? sanitizeSlug(input.slug) : sanitizeSlug(input.name);
  if (!slug) throw new Error('nombre inválido');
  if (!CATEGORIES.includes(input.category)) throw new Error('categoría inválida');

  const filename = `${slug}.md`;
  const dir = join(VAULT_PROJECTS, input.category);
  const fullPath = join(dir, filename);
  if (existsSync(fullPath)) throw new Error('proyecto ya existe: ' + slug);
  mkdirSync(dir, { recursive: true });

  const today = todayLocal();
  const fmObj = defaultFrontmatterFor(input.category, today);
  const yamlStr = yaml.dump(fmObj, { lineWidth: 200 }).trim();
  const front = `---\n${yamlStr}\n---\n\n`;
  const body  = `# ${input.name.trim()}\n\n`;
  writeFileSync(fullPath, front + body, 'utf8');

  const p = parseFile(input.category, filename);
  if (!p) throw new Error('parse falló tras crear');
  return p;
}

// ── Update ───────────────────────────────────────────────────────────────

export interface ProjectPatch {
  body?: string;
  frontmatter?: Record<string, unknown>;
  /** Si true, marca `updated` con la fecha de hoy antes de guardar */
  bump_updated?: boolean;
}

export function updateProject(file: string, patch: ProjectPatch): Project {
  const existing = getOne(file);
  if (!existing) throw new Error('proyecto no existe: ' + file);

  const filename = (file.endsWith('.md') ? file : file + '.md');
  const fullPath = join(VAULT_PROJECTS, existing.category, filename);

  // Merge: el patch.frontmatter reemplaza por completo (lo gestiona el UI con
  // todos los campos). Si solo viene body, conservamos frontmatter existente.
  const newFm = { ...existing.frontmatter, ...(patch.frontmatter ?? {}) };
  if (patch.bump_updated !== false) {
    newFm.updated = todayLocal();
  }
  const newBody = patch.body ?? existing.body;

  const yamlStr = yaml.dump(newFm, { lineWidth: 200 }).trim();
  const front = `---\n${yamlStr}\n---\n`;
  writeFileSync(fullPath, front + '\n' + newBody.replace(/^\n+/, ''), 'utf8');

  const p = parseFile(existing.category, filename);
  if (!p) throw new Error('parse falló tras update');
  return p;
}

// ── Delete ───────────────────────────────────────────────────────────────

export function deleteProject(file: string): void {
  const filename = file.endsWith('.md') ? file : file + '.md';
  for (const cat of CATEGORIES) {
    const fullPath = join(VAULT_PROJECTS, cat, filename);
    if (existsSync(fullPath)) { unlinkSync(fullPath); return; }
  }
  throw new Error('proyecto no existe: ' + file);
}
