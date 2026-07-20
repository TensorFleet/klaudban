import type { APIRoute } from 'astro';
import {
  listAll, getOne, createTask, updateTask, moveToStatus, deleteTask,
  toggleSubtask, reorderColumn, STATUSES, PRIORITIES, CARD_COLORS,
  type Status, type Priority, type CardColor,
} from '../../lib/tasks';
import { resolveAssigneeForCreate, ensureUserFromHeaders } from '../../lib/users';

// Aliases para los ops de Claude: el prompt usa formas cortas (start/review/done/stop)
// para curl menos ruidoso; los `claude_*` se mantienen por compat con prompts
// legacy ya copiados/pegados.
//   start  → claude_start  (pending|pending-review → doing + claude_active=true)
//   review → claude_review (doing → pending-review, espera input del usuario)
//   done   → claude_done   (archiva: mueve a tareas/done/, fin del flow)
//   stop   → claude_stop   (legacy: solo limpia claude_active sin mover)
const OP_ALIASES: Record<string, string> = {
  start:  'claude_start',
  review: 'claude_review',
  done:   'claude_done',
  stop:   'claude_stop',
};

export const prerender = false;

function bad(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
function ok(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

export const GET: APIRoute = ({ url, request }) => {
  // Side-effect: register the reverse-proxy principal if present.
  ensureUserFromHeaders(request.headers);
  const file = url.searchParams.get('file');
  if (file) {
    const t = getOne(file);
    if (!t) return bad('no existe', 404);
    return ok(t);
  }
  return ok({ tasks: listAll() });
};

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null);
  if (!body) return bad('body inválido');
  if (!body.title?.trim()) return bad('title requerido');
  try {
    const assignee = resolveAssigneeForCreate(request.headers, body as Record<string, unknown>);
    const t = createTask({
      title:      body.title,
      status:     validStatus(body.status),
      priority:   validPriority(body.priority),
      due:        body.due ?? null,
      project:    body.project ?? null,
      assignee,
      blocked_by: body.blocked_by ?? null,
      color:      validColor(body.color),
      body:       body.body,
    });
    return ok(t);
  } catch (e) {
    return bad(String((e as Error).message ?? e), 500);
  }
};

export const PATCH: APIRoute = async ({ url, request }) => {
  // Body opcional: los ops simples (start/done/stop) pueden venir solo por
  // query string, así el curl es `-X PATCH "...?file=X&op=done"` sin headers.
  const body = (await request.json().catch(() => null)) ?? {};

  // op: prioriza body sobre query string si vienen ambos.
  const rawOp = (typeof body.op === 'string' ? body.op : null)
             ?? url.searchParams.get('op');
  const op = rawOp ? (OP_ALIASES[rawOp] ?? rawOp) : null;

  // Reorder no requiere `file` (afecta varios)
  if (op === 'reorder' && Array.isArray(body.files)) {
    try { return ok({ updated: reorderColumn(body.files as string[]) }); }
    catch (e) { return bad(String((e as Error).message ?? e), 500); }
  }

  const file = url.searchParams.get('file');
  if (!file) return bad('file requerido');

  try {
    // Operaciones especiales
    if (op === 'move' && body.status) {
      const s = validStatus(body.status);
      if (!s) return bad('status inválido');
      return ok(moveToStatus(file, s));
    }
    if (op === 'toggle_subtask' && typeof body.line === 'number') {
      return ok(toggleSubtask(file, body.line));
    }
    if (op === 'claude_start') {
      const current = getOne(file);
      if (!current) return bad('no existe', 404);
      // Si está en pending o pending-review, moverla a doing antes de prender
      // el flag. pending-review = retomar tras revisión: el usuario pidió
      // cambios o Claude vuelve por su cuenta, debe pintar naranja de nuevo.
      if (current.status === 'pending' || current.status === 'pending-review') {
        const moved = moveToStatus(file, 'doing');
        return ok(updateTask(moved.file, { claude_active: true }));
      }
      return ok(updateTask(file, { claude_active: true }));
    }
    if (op === 'claude_review') {
      // Claude termina pero queda algo que requiere input del usuario (sudo,
      // decisión, deploy manual). Va a `pending-review` para que el usuario
      // resuelva, eventualmente Claude o el usuario la cierra con op=done.
      return ok(moveToStatus(file, 'pending-review'));
    }
    if (op === 'claude_done') {
      // Cierre real: la tarea está hecha, verificada, sin pendientes del
      // usuario. Mueve a `tareas/done/`. moveToStatus limpia claude_active.
      return ok(moveToStatus(file, 'done'));
    }
    if (op === 'claude_stop') {
      // Compat: limpia solo el flag sin mover. Prompts viejos lo siguen usando.
      return ok(updateTask(file, { claude_active: false }));
    }
    // Update general
    const t = updateTask(file, {
      title:      body.title,
      status:     validStatus(body.status),
      priority:   validPriority(body.priority),
      date:       body.date,
      due:        body.due,
      project:    body.project,
      assignee:   body.assignee,
      blocked_by: body.blocked_by,
      color:      body.color === undefined ? undefined : validColor(body.color),
      body:       body.body,
    });
    return ok(t);
  } catch (e) {
    return bad(String((e as Error).message ?? e), 500);
  }
};

export const DELETE: APIRoute = ({ url }) => {
  const file = url.searchParams.get('file');
  if (!file) return bad('file requerido');
  try {
    deleteTask(file);
    return ok({ ok: true });
  } catch (e) {
    return bad(String((e as Error).message ?? e), 500);
  }
};

function validStatus(s: unknown): Status | undefined {
  if (s == null) return undefined;
  return STATUSES.includes(s as Status) ? (s as Status) : undefined;
}
function validPriority(p: unknown): Priority | undefined {
  if (p == null) return undefined;
  return PRIORITIES.includes(p as Priority) ? (p as Priority) : undefined;
}
// `color: null` significa "quitar el color" — distinto de "no tocar". El
// caller decide pasar undefined si no quiere modificar el campo.
function validColor(c: unknown): CardColor | null {
  if (c == null) return null;
  return CARD_COLORS.includes(c as CardColor) ? (c as CardColor) : null;
}
