# Klaudban for AI agents

Klaudban exposes a small JSON-over-HTTP API so an agent (Claude Code, Cursor's CLI, Aider, Cline, your own script) can create, track, and close tasks on the board. The board polls every 5 seconds and reflects whatever the agent does within that window — orange ring + animation while a task is active, yellow ring when it's waiting for the user.

This file is what you point your agent at. It's also a good spec to drop into a model's system prompt so it knows how to drive the board on its own.

## Setup

Set `claude.enabled: true` and `claude.apiBaseUrl` in `klaudban.config.json`:

```jsonc
{
  "claude": {
    "enabled":    true,
    "apiBaseUrl": "http://localhost:4321"  // or your Tailscale URL, etc.
  }
}
```

`apiBaseUrl` is what the agent will `curl` against. It has to be reachable from wherever the agent runs (your laptop, a server, a CI container). For purely local agents `http://localhost:4321` is fine; for an agent on a different machine, expose the board over Tailscale / a VPN and use that hostname.

## System prompt snippet

Drop this into your agent's persistent context (Claude Code's project `CLAUDE.md`, a Cursor rule, an Aider config, etc.). Replace the URL.

```
You have access to a Klaudban API at <YOUR_API_BASE_URL> (a self-hosted markdown kanban).
Use it to track real work the user gives you.

Lifecycle:

1. CREATE a task when the user asks for something new. Title concise (<60 chars).
   curl -sX POST "<API>/api/tasks" -H 'Content-Type: application/json' \
     -d '{"title":"<title>","priority":"normal","project":"<slug or null>","body":"<optional markdown notes>"}'
   The response includes the task's `file` field — keep it for subsequent calls.

2. START a task when you actually begin work (not when you read the prompt):
   curl -sX PATCH "<API>/api/tasks?file=<file>&op=start"
   This sets claude_active:true and moves the card to "In progress".
   Also use op=start to RESUME a task already in "Pending review" (user asked for changes, follow-up, you came back to it).

3. CLOSE with one of two ops:
   - op=done    → 100% finished and verified by you. Archives the task to tasks/done/.
   - op=review  → done what you could, but the user has to finish (sudo, manual deploy, decision, smoke test).
                  Task stays visible in the yellow "Pending review" strip.

Choose done vs review honestly. Closing as done something that still needs the user removes their signal that work is pending.

Don't call op=start if you're just answering a one-off question without intending to log it. The board is for real, trackable work.
```

That snippet plus your `<YOUR_API_BASE_URL>` is enough — the agent learns the whole workflow from it.

## Endpoint reference

| Endpoint                                     | Method        | What it does                                                                    |
|----------------------------------------------|---------------|---------------------------------------------------------------------------------|
| `/api/tasks`                                 | `GET`         | List all tasks (active + done). Returns `{ tasks: Task[] }`.                    |
| `/api/tasks?file=<file>`                     | `GET`         | Fetch one task.                                                                 |
| `/api/tasks`                                 | `POST`        | Create a task. Body: `{ title, priority?, project?, due?, body?, color?, status? }`. Returns the created task. |
| `/api/tasks?file=<file>`                     | `PATCH`       | Edit any field. Body: partial task.                                             |
| `/api/tasks?file=<file>&op=start`            | `PATCH`       | Mark in-progress, set `claude_active: true`. Idempotent.                        |
| `/api/tasks?file=<file>&op=done`             | `PATCH`       | Archive to `tasks/done/`. Clears `claude_active`.                               |
| `/api/tasks?file=<file>&op=review`           | `PATCH`       | Move to `pending-review`. Clears `claude_active`. Visible in yellow strip.      |
| `/api/tasks?file=<file>&op=move`             | `PATCH`       | Change `status` via `status=<pending|doing|blocked|pending-review|done>`.       |
| `/api/tasks?file=<file>`                     | `DELETE`      | Delete the file from the vault.                                                 |
| `/api/projects`                              | `GET`         | List project docs.                                                              |
| `/api/projects`                              | `POST`        | Create a project doc. Body: `{ name, category, slug? }`.                        |
| `/api/projects/<file>`                       | `GET / PATCH / DELETE` | CRUD a project.                                                        |

All query strings + JSON bodies. No auth (see README's security note).

## Rule of thumb: `op=done` vs `op=review`

This is the only non-obvious call.

- **`op=done`** when you can honestly say "this task is finished, I checked, nothing left." The card is archived and the user doesn't see it again unless they toggle "Show older" in the Done column.
- **`op=review`** when you can't fully verify or there's something only the user can do — `sudo`, `apt install`, a manual deploy, a UX decision, eyeballing the output of a UI change. The card stays in the yellow strip above "In progress" until the user takes over.

If in doubt, use `op=review`. False positives (archiving something that wasn't really done) are worse than false negatives (asking the user to glance and approve) because they erase the signal that work is pending.

## Example session

User: *"Bump the Astro version to the latest minor."*

```
# Agent creates the task
> curl -sX POST "$API/api/tasks" -H 'Content-Type: application/json' \
    -d '{"title":"Bump Astro to latest 4.x","priority":"normal","project":"klaudban"}'
{"file":"2026-05-23 Bump Astro to latest 4.x.md", ...}

# Agent starts work
> curl -sX PATCH "$API/api/tasks?file=2026-05-23%20Bump%20Astro%20to%20latest%204.x.md&op=start"

# ... agent edits package.json, runs npm install, builds, runs tests ...

# Build passed, tests green → done
> curl -sX PATCH "$API/api/tasks?file=2026-05-23%20Bump%20Astro%20to%20latest%204.x.md&op=done"
```

Same session, alternate ending where it needs the user:

```
# ... agent edits, but the change touches the systemd unit and needs sudo to reload ...

> curl -sX PATCH "$API/api/tasks?file=2026-05-23%20Bump%20Astro%20to%20latest%204.x.md&op=review"
```

Then a message to the user: *"Bumped Astro and rebuilt. Restart needed (`sudo systemctl restart klaudban`) — left it in Pending review."*

## Notifications back to the agent

The board's polling + notification panel exists for **you** (the human), not for the agent. The agent fires events; the bell shows them. If you want the agent to react to events on the board (you moved a card, you added a comment), that's not built yet — see Roadmap in the main README.

## User id migration (CLI / agents)

Rename or merge a user id across `klaudban.config.json` **and** task frontmatter
`assignee:` fields. No UI — CLI only (safe for humans and AI agents).

```bash
# Always dry-run first
npm run user:migrate -- <fromId> <toId> --dry-run

# Apply (requires --yes)
npm run user:migrate -- <fromId> <toId> --yes

# Or directly:
node scripts/migrate-user-id.mjs <fromId> <toId> --dry-run
node scripts/migrate-user-id.mjs <fromId> <toId> --yes
```

### Behavior
| Case | Result |
|------|--------|
| target **missing** | rename source user entry → `toId` |
| target **exists** | **merge**: union `providers[]`, merge label/emoji, drop source entry |
| either missing from config | still rewrites task `assignee:` values |

- **Tasks:** every `assignee: <fromId>` under `vault.tasksDir` → `<toId>`
- **Label rule:** keep target label unless it is a placeholder
  (empty, or equals the full id). Email local-part alone is **not** treated
  as a placeholder (so a real name like "Levi" for `levi@…` is kept).
- **Providers:** unique union of both sides
- **Safety:** refuses to write without `--yes`; use `--dry-run` to print the plan as JSON.
  Malformed task YAML is listed in `skippedFiles`; `--yes` aborts unless `--force`.
  YAML uses CORE_SCHEMA so `due:` / `date:` stay strings.
- **cwd:** run from the klaudban app directory (where `klaudban.config.json` lives),
  or pass `--cwd /path/to/app`

### Agent note
When consolidating a config-only handle into an auth email (or linking a second
IdP onto an existing email id), use this CLI instead of hand-editing markdown.
After a successful migrate, restart is **not** required for tasks (files on disk);
the running process reloads users from disk on the next ensure/list path, but a
restart is the surest way to refresh in-memory state:

```bash
systemctl --user restart klaudban.service   # if deployed that way
```

## What's NOT exposed

- No auth, no per-user permissions. Anyone with network access to `apiBaseUrl` can read and write. See the Security note in the main README.
- No real-time push (SSE / WebSocket). The board polls every 5s; the agent's `curl` updates the file immediately, but the UI takes up to 5s to reflect.
- No "agent identity" — every call looks the same. If you want a per-agent activity log, write it as a comment in the task body.
- No HTTP admin API for user migration yet — use `npm run user:migrate` / `scripts/migrate-user-id.mjs` only.
