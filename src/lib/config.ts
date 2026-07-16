/**
 * Config loader. Reads `klaudban.config.json` (optional) from the CWD of the
 * process. Everything is optional; missing fields fall back to defaults.
 *
 * NO env vars by design — all app configuration lives in a single versionable
 * (or gitignorable) file at the repo root.
 *
 * Schema example (see klaudban.config.example.json):
 *   {
 *     "vault":   { "tasksDir": "./vault/tasks", "projectsDir": "./vault/projects", "embedsDir": "./vault/embeds" },
 *     "ui":      { "timezone": "UTC", "title": "Vault" },
 *     "claude":  { "enabled": false, "apiBaseUrl": "http://localhost:3004" },
 *     "projects": {
 *       "categories": [
 *         { "key": "personal", "label": "Personal", "emoji": "🚀", "fields": ["type","updated","status","path"] },
 *         { "key": "work",     "label": "Work",     "emoji": "💼", "fields": ["type","updated","employer","path"] }
 *       ]
 *     },
 *     "users": [
 *       { "id": "alice", "label": "Alice", "emoji": "👤" }
 *     ]
 *   }
 *
 * Categories define the sub-folders under `projectsDir/` and the structured
 * fields that show up in the project edit modal. The `key` is the folder
 * name and the value used for the `type:` frontmatter prefix (`project-<key>`).
 *
 * Users are optional. When empty, the assignee picker stays unassigned-only
 * until you add members in klaudban.config.json.
 */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

export interface CategoryConfig {
  key:    string;
  label:  string;
  emoji?: string;
  /** Frontmatter fields shown as inputs in the project edit modal. */
  fields?: string[];
  /** Optional override for the frontmatter `type:` value. Default: `project-<key>`. */
  type?:  string;
}

export interface TeamUser {
  id:    string;
  label: string;
  emoji?: string;
}

export interface AppConfig {
  vault: {
    tasksDir:   string;
    projectsDir: string;
    embedsDir:   string;
  };
  ui: {
    timezone: string;
    title:    string;
    /** UI locale. Bundled: 'en', 'es'. Drop more JSON in src/i18n/ to add. */
    locale:   string;
  };
  claude: {
    enabled:    boolean;
    apiBaseUrl: string | null;
  };
  projects: {
    categories: CategoryConfig[];
  };
  /** Team members available in the task assignee picker. */
  users: TeamUser[];
}

const DEFAULTS: AppConfig = {
  vault: {
    tasksDir:   './vault/tasks',
    projectsDir: './vault/projects',
    embedsDir:   './vault/embeds',
  },
  ui: {
    timezone: 'UTC',
    title:    '',          // empty = derive from tasksDir parent folder name
    locale:   'en',
  },
  claude: {
    enabled:    false,
    apiBaseUrl: null,
  },
  projects: {
    categories: [
      { key: 'personal', label: 'Personal', emoji: '🚀', fields: ['type', 'updated', 'status', 'path'] },
      { key: 'work',     label: 'Work',     emoji: '💼', fields: ['type', 'updated', 'employer', 'path'] },
    ],
  },
  users: [],
};

const CONFIG_FILENAME = 'klaudban.config.json';

function loadFromFile(): Partial<AppConfig> {
  try {
    const path = resolve(process.cwd(), CONFIG_FILENAME);
    const raw  = readFileSync(path, 'utf8');
    return JSON.parse(raw) as Partial<AppConfig>;
  } catch {
    return {};
  }
}

function deepMerge<T>(base: T, patch: Partial<T>): T {
  const out: any = { ...base };
  for (const k of Object.keys(patch) as (keyof T)[]) {
    const pv = patch[k];
    if (pv && typeof pv === 'object' && !Array.isArray(pv) && (base as any)[k] && typeof (base as any)[k] === 'object') {
      out[k] = deepMerge((base as any)[k], pv as any);
    } else if (pv !== undefined) {
      out[k] = pv;
    }
  }
  return out;
}

const fileConfig = loadFromFile();
export const CONFIG: AppConfig = deepMerge(DEFAULTS, fileConfig);

export const VAULT_TASKS   = resolve(process.cwd(), CONFIG.vault.tasksDir);

/**
 * Derive a human-friendly title for the header. Priority:
 *   1. `ui.title` from config (if explicitly set)
 *   2. the parent folder of `tasksDir` (e.g. `vault/tasks` → "vault", a real
 *      Obsidian vault at `/Users/me/MyVault/tasks` → "MyVault")
 *   3. fallback to "Klaudban"
 *
 * Using the folder name as default makes the header reflect the user's vault
 * without them having to configure anything — point `tasksDir` at your real
 * Obsidian directory and the header takes its name automatically.
 */
function deriveVaultName(): string {
  const segments = VAULT_TASKS.replace(/\/+$/, '').split('/');
  return segments[segments.length - 2] || '';
}
export const HEADER_TITLE: string = CONFIG.ui.title || deriveVaultName() || 'Klaudban';
export const VAULT_PROJECTS = resolve(process.cwd(), CONFIG.vault.projectsDir);
export const VAULT_EMBEDS   = resolve(process.cwd(), CONFIG.vault.embedsDir);
export const VAULT_DONE     = join(VAULT_TASKS, 'done');

// Derived from CONFIG.projects.categories — used everywhere instead of the
// previous hardcoded enum.
export const CATEGORY_KEYS:    string[]                      = CONFIG.projects.categories.map(c => c.key);
export const CATEGORY_LABEL:   Record<string, string>        = Object.fromEntries(CONFIG.projects.categories.map(c => [c.key, c.label]));
export const CATEGORY_EMOJI:   Record<string, string>        = Object.fromEntries(CONFIG.projects.categories.map(c => [c.key, c.emoji ?? '📁']));
export const CATEGORY_FIELDS:  Record<string, string[]>      = Object.fromEntries(CONFIG.projects.categories.map(c => [c.key, c.fields ?? ['type', 'updated']]));
export const CATEGORY_TYPE:    Record<string, string>        = Object.fromEntries(CONFIG.projects.categories.map(c => [c.key, c.type ?? `project-${c.key}`]));

export const TEAM_USERS: TeamUser[] = CONFIG.users ?? [];
