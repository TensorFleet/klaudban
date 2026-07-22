/**
 * GET    /api/projects/[file]       → un proyecto completo
 * PATCH  /api/projects/[file]       → actualiza body y/o frontmatter
 * DELETE /api/projects/[file]       → borra del filesystem
 */
import type { APIRoute } from 'astro';
import { getOne, updateProject, deleteProject } from '../../../lib/projects';

export const prerender = false;

function bad(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

function ok(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

export const GET: APIRoute = ({ params }) => {
  const file = params.file;
  if (!file) return bad('file requerido');
  const p = getOne(file);
  if (!p) return bad('proyecto no existe', 404);
  return ok(p);
};

export const PATCH: APIRoute = async ({ params, request }) => {
  const file = params.file;
  if (!file) return bad('file requerido');
  const body = await request.json().catch(() => null);
  if (!body) return bad('body inválido');
  try {
    const p = updateProject(file, body);
    return ok(p);
  } catch (e) {
    return bad((e as Error).message, 404);
  }
};

export const DELETE: APIRoute = ({ params }) => {
  const file = params.file;
  if (!file) return bad('file requerido');
  try {
    deleteProject(file);
    return ok({ ok: true });
  } catch (e) {
    return bad((e as Error).message, 404);
  }
};
