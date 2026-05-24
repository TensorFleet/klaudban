/**
 * Tasks: vault → board.
 *
 * Source: the directory configured by `vault.tasksDir` in `klaudban.config.json`
 * (default `./vault/tasks`). Each `.md` file is a task.
 *
 * Statuses:
 *   - pending / doing / blocked / pending-review: file in the tasks root, status in frontmatter
 *   - done: file in tasks/done/ (location is the source of truth, not frontmatter)
 *
 * `pending-review` is the intermediate state set by `op=review`: the task stays
 * visible on the board (yellow sub-section above "In progress") waiting for the
 * user to either approve it (move to Done) or re-open with `op=start`.
 *
 * Frontmatter shape:
 *   date: YYYY-MM-DD       creation date
 *   type: tarea            convention to distinguish from project docs
 *   status: pending|doing|blocked|pending-review    default 'pending'
 *   priority: critical|high|normal|low              default 'normal'
 *   due: YYYY-MM-DD        optional
 *   project: filename      optional, matches a file in projectsDir (no .md)
 *   blocked_by: text       optional, free text or wikilink
 *   color: <name>          optional banner color (see CARD_COLORS)
 *   claude_active: bool    set by op=start, cleared on op=done/review
 *   pos: number            optional manual sort order within a column
 */
import { readdirSync, readFileSync, writeFileSync, unlinkSync, mkdirSync,
         renameSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import yaml from 'js-yaml';
import { marked } from 'marked';
import { getOne as getProjectDoc, updateProject } from './projects';
import { CONFIG, VAULT_TASKS, VAULT_DONE, VAULT_PROJECTS, VAULT_EMBEDS } from './config';

export { VAULT_EMBEDS };

marked.setOptions({ gfm: true, breaks: false });

export type Status   = 'pending' | 'doing' | 'blocked' | 'pending-review' | 'done';
export type Priority = 'critical' | 'high' | 'normal' | 'low';
// Color libre de la card (banner superior estilo Trello). null = sin color.
export type CardColor = 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'gray';

export const STATUSES: Status[] = ['pending', 'doing', 'blocked', 'pending-review', 'done'];
export const PRIORITIES: Priority[] = ['critical', 'high', 'normal', 'low'];
export const CARD_COLORS: CardColor[] = ['yellow', 'green', 'blue', 'purple', 'pink', 'gray'];

export interface Subtask {
  text: string;
  done: boolean;
  line: number;
}

export interface Task {
  file: string;          // basename con extensión, ej: "2026-05-22 Comprar pan.md"
  title: string;         // del filename o primer H1/H2 del body
  status: Status;
  priority: Priority;
  date: string | null;   // creación
  due: string | null;
  project: string | null;
  blocked_by: string | null;
  pos: number | null;    // orden manual dentro de columna (mayor = arriba)
  claude_active: boolean; // true mientras Claude trabaja en la tarea
  color: CardColor | null; // banner de color en la card; null = sin banner
  body: string;          // markdown sin frontmatter
  body_html: string;     // markdown renderizado a HTML (con embeds resueltos)
  subtasks: Subtask[];
  mtime: number;
}

// ── Markdown render con soporte de embeds Obsidian ──────────────────────
// Obsidian usa ![[file]] para embeds. Lo convertimos a HTML antes de pasar
// a marked. Mapeo: ![[name.png]] → <img src="/api/embed?file=name.png">
// Para no-imágenes (![[nota]] sin extensión), lo dejamos como wikilink visual.
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov)$/i;
const AUDIO_EXT = /\.(mp3|m4a|wav|ogg)$/i;

function resolveObsidianEmbeds(md: string): string {
  // ![[file]] o ![[file|alt]]
  return md.replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, name, alt) => {
    const fn = String(name).trim();
    const safe = fn.replace(/"/g, '&quot;');
    const altText = (alt ?? fn).trim().replace(/"/g, '&quot;');
    if (IMG_EXT.test(fn))   return `<img src="/api/embed?file=${encodeURIComponent(fn)}" alt="${altText}" loading="lazy" />`;
    if (VIDEO_EXT.test(fn)) return `<video src="/api/embed?file=${encodeURIComponent(fn)}" controls></video>`;
    if (AUDIO_EXT.test(fn)) return `<audio src="/api/embed?file=${encodeURIComponent(fn)}" controls></audio>`;
    // Embed de archivo no soportado (otro .md) — wikilink visual
    return `<span class="wikilink">📄 ${safe}</span>`;
  })
  // [[wikilink]] (sin !)
  .replace(/(^|[^!])\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, prev, name, alt) => {
    const display = (alt ?? name).trim().replace(/[<>]/g, '');
    return `${prev}<span class="wikilink">🔗 ${display}</span>`;
  });
}

function renderBody(md: string): string {
  const pre = resolveObsidianEmbeds(md);
  const html = marked.parse(pre, { async: false }) as string;
  return html;
}

// ── Parse ─────────────────────────────────────────────────────────────────

const FRONT_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseFile(filename: string, dir: string): Task | null {
  const fullPath = join(dir, filename);
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
    // CORE_SCHEMA evita que YAML auto-parse "2026-05-22" como Date JS (que
    // luego String() convierte a "Thu May 21 2026 19:00:00 GMT-0500..." y
    // rompe los filtros que comparan por string ISO).
    try { frontmatter = (yaml.load(m[1], { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>) ?? {}; }
    catch { frontmatter = {}; }
    body = m[2];
  }

  // priority puede venir como string o como array (existe legacy con `priority: [low]`)
  let priority: Priority = 'normal';
  const rawPrio = frontmatter.priority;
  if (Array.isArray(rawPrio) && rawPrio.length) priority = normalizePrio(String(rawPrio[0]));
  else if (typeof rawPrio === 'string')         priority = normalizePrio(rawPrio);

  // status — si está en done/ siempre 'done' aunque frontmatter diga otra cosa
  let status: Status;
  if (dir === VAULT_DONE) status = 'done';
  else {
    const rawStatus = String(frontmatter.status ?? 'pending').toLowerCase();
    status = (['pending', 'doing', 'blocked', 'pending-review'].includes(rawStatus) ? rawStatus : 'pending') as Status;
  }

  const title = deriveTitle(filename, body);
  const subtasks = extractSubtasks(body);

  const posRaw = frontmatter.pos;
  const pos = typeof posRaw === 'number' ? posRaw : (typeof posRaw === 'string' ? Number(posRaw) || null : null);

  const claudeRaw = frontmatter.claude_active;
  const claude_active = status !== 'done' && status !== 'pending-review' && (
    claudeRaw === true || String(claudeRaw).toLowerCase() === 'true'
  );

  const rawColor = frontmatter.color;
  const color: CardColor | null = typeof rawColor === 'string'
    && (CARD_COLORS as readonly string[]).includes(rawColor.toLowerCase())
    ? (rawColor.toLowerCase() as CardColor)
    : null;

  return {
    file: filename,
    title,
    status,
    priority,
    date:    nullableString(frontmatter.date),
    due:     nullableString(frontmatter.due),
    project: nullableString(frontmatter.project),
    blocked_by: nullableString(frontmatter.blocked_by),
    pos,
    claude_active,
    color,
    body,
    body_html: renderBody(body),
    subtasks,
    mtime,
  };
}

function normalizePrio(s: string): Priority {
  const v = s.toLowerCase().trim();
  if (v === 'critical' || v === 'crítica' || v === 'critica') return 'critical';
  if (v === 'high' || v === 'alta')   return 'high';
  if (v === 'low'  || v === 'baja')   return 'low';
  return 'normal';
}

function nullableString(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function deriveTitle(filename: string, body: string): string {
  // Filename: "YYYY-MM-DD Título.md" o "pendiente-<slug>.md"
  const noExt = filename.replace(/\.md$/, '');
  const dated = noExt.match(/^\d{4}-\d{2}-\d{2}\s+(.+)$/);
  if (dated) return dated[1].trim();
  const pendiente = noExt.match(/^pendiente-(.+)$/);
  if (pendiente) return pendiente[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  // Fallback: primer H1/H2 del body
  const h = body.match(/^#{1,2}\s+(.+)$/m);
  return h ? h[1].trim() : noExt;
}

function extractSubtasks(body: string): Subtask[] {
  const lines = body.split(/\r?\n/);
  const out: Subtask[] = [];
  lines.forEach((line, idx) => {
    const m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (m) out.push({ done: m[1].toLowerCase() === 'x', text: m[2].trim(), line: idx });
  });
  return out;
}

// ── List ──────────────────────────────────────────────────────────────────

function listDir(dir: string): Task[] {
  let entries: string[];
  try { entries = readdirSync(dir); }
  catch { return []; }
  const out: Task[] = [];
  for (const f of entries) {
    if (!f.endsWith('.md')) continue;
    if (f.startsWith('._') || f.startsWith('.')) continue;  // AppleDouble / hidden files de Syncthing
    const t = parseFile(f, dir);
    if (t) out.push(t);
  }
  return out;
}

export function listAll(): Task[] {
  const active = listDir(VAULT_TASKS);
  const done   = listDir(VAULT_DONE);
  return [...active, ...done];
}

export function getOne(filename: string): Task | null {
  const safe = sanitizeFilename(filename);
  // Buscar primero en activas, luego en done
  if (existsSync(join(VAULT_TASKS, safe))) return parseFile(safe, VAULT_TASKS);
  if (existsSync(join(VAULT_DONE, safe)))   return parseFile(safe, VAULT_DONE);
  return null;
}

// ── Projects (lista de filenames disponibles) ────────────────────────────

export function listProjects(): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const f of entries) {
      const p = join(dir, f);
      let s;
      try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) walk(p);
      else if (f.endsWith('.md')) out.push(f.replace(/\.md$/, ''));
    }
  }
  walk(VAULT_PROJECTS);
  return out.sort();
}

// ── Write ─────────────────────────────────────────────────────────────────

export interface TaskInput {
  title: string;
  status?: Status;
  priority?: Priority;
  date?: string | null;     // creación; default hoy
  due?: string | null;
  project?: string | null;
  blocked_by?: string | null;
  pos?: number | null;
  claude_active?: boolean;
  color?: CardColor | null;
  body?: string;            // markdown sin frontmatter
}

function todayLocal(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: CONFIG.ui.timezone });
}

// Bump del `updated:` del doc del proyecto al que pertenece la tarea. Se llama
// desde createTask/updateTask/moveToStatus para que la fecha "última vez que
// se tocó este proyecto" se mantenga viva sin que el usuario tenga que editar
// el .md del proyecto a mano. Silent si el proyecto no tiene doc (proyectos
// referenciados por nombre pero sin .md en vault/projects/ existen, ej. legacy).
function touchProject(name: string | null | undefined): void {
  if (!name) return;
  try {
    if (getProjectDoc(name)) updateProject(name, { bump_updated: true });
  } catch {
    // Bump es best-effort: la tarea ya se escribió, un fallo acá no debe
    // tumbar la operación principal.
  }
}

function sanitizeFilename(name: string): string {
  // Permite letras/números/espacios/guiones/punto, evita path traversal
  return name.replace(/[\\/]/g, '').replace(/\.\./g, '').trim();
}

function buildFrontmatter(t: TaskInput, currentDate: string): string {
  const fm: Record<string, unknown> = {
    date: t.date ?? currentDate,
    type: 'tarea',
  };
  if (t.status   && t.status !== 'pending')     fm.status = t.status;
  if (t.priority && t.priority !== 'normal')    fm.priority = t.priority;
  if (t.due)        fm.due = t.due;
  if (t.project)    fm.project = t.project;
  if (t.blocked_by) fm.blocked_by = t.blocked_by;
  if (t.pos != null) fm.pos = t.pos;
  if (t.claude_active) fm.claude_active = true;
  if (t.color) fm.color = t.color;
  const yamlStr = yaml.dump(fm, { lineWidth: 100 }).trim();
  return `---\n${yamlStr}\n---\n`;
}

export function createTask(input: TaskInput): Task {
  if (!input.title?.trim()) throw new Error('title required');
  const date = input.date ?? todayLocal();
  const filename = sanitizeFilename(`${date} ${input.title.trim()}.md`);
  const fullPath = join(VAULT_TASKS, filename);
  if (existsSync(fullPath)) throw new Error('archivo ya existe: ' + filename);
  const front = buildFrontmatter({ ...input, date }, date);
  const body  = input.body ?? `- [ ] ${input.title.trim()}\n`;
  writeFileSync(fullPath, front + '\n' + body, 'utf8');
  const t = parseFile(filename, VAULT_TASKS);
  if (!t) throw new Error('parse falló tras crear');
  touchProject(t.project);
  return t;
}

export function updateTask(
  filename: string,
  patch: Partial<TaskInput>,
  options: { skipProjectTouch?: boolean } = {},
): Task {
  const safe = sanitizeFilename(filename);
  const existing = getOne(safe);
  if (!existing) throw new Error('tarea no existe: ' + safe);

  const inDone = existing.status === 'done';
  const dir = inDone ? VAULT_DONE : VAULT_TASKS;
  const fullPath = join(dir, safe);

  const merged: TaskInput = {
    title:      patch.title      ?? existing.title,
    status:     patch.status     ?? existing.status,
    priority:   patch.priority   ?? existing.priority,
    date:       patch.date       !== undefined ? patch.date       : existing.date,
    due:        patch.due        !== undefined ? patch.due        : existing.due,
    project:    patch.project    !== undefined ? patch.project    : existing.project,
    blocked_by: patch.blocked_by !== undefined ? patch.blocked_by : existing.blocked_by,
    pos:        patch.pos        !== undefined ? patch.pos        : existing.pos,
    claude_active: patch.claude_active !== undefined ? patch.claude_active : existing.claude_active,
    color:      patch.color      !== undefined ? patch.color      : existing.color,
    body:       patch.body       ?? existing.body,
  };
  if (merged.status === 'done' || merged.status === 'pending-review') merged.claude_active = false;

  // Si el status nuevo es 'done', mover a done/ (no permitir 'done' en frontmatter
  // en el dir activo — la convención es que done = ubicación de archivo).
  if (merged.status === 'done' && !inDone) {
    return moveToStatus(safe, 'done');
  }
  // Si está en done y mueve a otro status, también es un move.
  if (merged.status !== 'done' && inDone) {
    return moveToStatus(safe, merged.status ?? 'pending');
  }

  const date = merged.date ?? existing.date ?? todayLocal();
  const front = buildFrontmatter({ ...merged, date }, date);
  const body  = merged.body ?? '';
  writeFileSync(fullPath, front + '\n' + body.replace(/^\n+/, ''), 'utf8');
  const t = parseFile(safe, dir);
  if (!t) throw new Error('parse falló tras update');
  // Bump del proyecto si hubo cambio significativo. Reorder (solo `pos`) NO
  // bumpea — es organizacional, no actividad real sobre el proyecto.
  if (!options.skipProjectTouch) {
    const onlyPos = Object.keys(patch).length > 0 && Object.keys(patch).every(k => k === 'pos');
    if (!onlyPos) {
      touchProject(t.project);
      // Si el patch movió la tarea entre proyectos, bumpear también el viejo.
      if (existing.project && existing.project !== t.project) touchProject(existing.project);
    }
  }
  return t;
}

export function moveToStatus(filename: string, status: Status): Task {
  const safe = sanitizeFilename(filename);
  const existing = getOne(safe);
  if (!existing) throw new Error('tarea no existe: ' + safe);
  const fromDir = existing.status === 'done' ? VAULT_DONE : VAULT_TASKS;
  const toDir   = status === 'done' ? VAULT_DONE : VAULT_TASKS;
  if (status === 'done' && !existsSync(VAULT_DONE)) mkdirSync(VAULT_DONE, { recursive: true });

  // Reescribir frontmatter con nuevo status (excepto 'done' que no se persiste,
  // se infiere de la ubicación del archivo).
  const date = existing.date ?? todayLocal();
  const front = buildFrontmatter({
    title: existing.title,
    status: status === 'done' ? 'pending' : status,  // ignorado en build si default
    priority: existing.priority,
    date,
    due: existing.due,
    project: existing.project,
    blocked_by: existing.blocked_by,
    pos: existing.pos,
    claude_active: (status === 'done' || status === 'pending-review') ? false : existing.claude_active,
    color: existing.color,
  }, date);
  const body = existing.body.replace(/^\n+/, '');

  const fromPath = join(fromDir, safe);
  const toPath   = join(toDir, safe);
  writeFileSync(fromPath, front + '\n' + body, 'utf8');
  if (fromDir !== toDir) renameSync(fromPath, toPath);
  const t = parseFile(safe, toDir);
  if (!t) throw new Error('parse falló tras mover');
  touchProject(t.project);
  return t;
}

export function deleteTask(filename: string): void {
  const safe = sanitizeFilename(filename);
  for (const dir of [VAULT_TASKS, VAULT_DONE]) {
    const p = join(dir, safe);
    if (existsSync(p)) { unlinkSync(p); return; }
  }
  throw new Error('tarea no existe: ' + safe);
}

/**
 * Reordena una columna: recibe el orden completo deseado (de arriba a abajo)
 * y asigna `pos` decreciente (10000, 9990, 9980...) a cada archivo. Solo
 * escribe los que cambiaron de pos para minimizar writes. El step grande deja
 * espacio para inserts manuales sin recalcular (un drop intermedio puede usar
 * el promedio entre vecinos).
 */
export function reorderColumn(files: string[]): Task[] {
  const STEP = 10;
  const TOP  = files.length * STEP;
  const out: Task[] = [];
  files.forEach((f, idx) => {
    const safe = sanitizeFilename(f);
    const existing = getOne(safe);
    if (!existing) return;
    const newPos = TOP - idx * STEP;
    if (existing.pos === newPos) { out.push(existing); return; }
    // Reorder visual no es "actividad" sobre el proyecto — skip bump.
    out.push(updateTask(safe, { pos: newPos }, { skipProjectTouch: true }));
  });
  return out;
}

export function toggleSubtask(filename: string, lineIndex: number): Task {
  const existing = getOne(filename);
  if (!existing) throw new Error('tarea no existe');
  const lines = existing.body.split(/\r?\n/);
  const line = lines[lineIndex];
  if (line == null) throw new Error('línea fuera de rango');
  const replaced = line.replace(/^(\s*[-*]\s+\[)([ xX])(\])/, (_m, p1, mark, p3) =>
    `${p1}${mark.toLowerCase() === 'x' ? ' ' : 'x'}${p3}`);
  if (replaced === line) throw new Error('línea no es un checkbox');
  lines[lineIndex] = replaced;
  return updateTask(filename, { body: lines.join('\n') });
}

export function bareBasename(path: string): string {
  return basename(path);
}
