/**
 * GET  /api/projects             → { projects: string[] } — names solo (compat con dropdown del modal de tareas)
 * GET  /api/projects?full=1      → { projects: Project[] } — info completa para la página /proyectos
 * POST /api/projects             → crea proyecto { name, category, slug? }
 */
import type { APIRoute } from 'astro';
import { listProjects } from '../../lib/tasks';
import { listAll, createProject, CATEGORIES, type Category } from '../../lib/projects';
import { withWriteLock } from '../../lib/write-lock';

export const prerender = false;

function bad(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const GET: APIRoute = ({ url }) => {
  if (url.searchParams.get('full') === '1') {
    return new Response(JSON.stringify({ projects: listAll() }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  // Compat: el modal de tareas espera { projects: string[] }
  return new Response(JSON.stringify({ projects: listProjects() }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null);
  if (!body) return bad('body inválido');
  const { name, category, slug } = body as { name?: string; category?: string; slug?: string };
  if (!name?.trim()) return bad('name requerido');
  if (!category || !CATEGORIES.includes(category as Category)) {
    return bad(`category debe ser una de: ${CATEGORIES.join(', ')}`);
  }
  try {
    const p = await withWriteLock(() =>
      createProject({ name: name.trim(), category: category as Category, slug }),
    );
    return new Response(JSON.stringify(p), {
      status: 201, headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return bad((e as Error).message);
  }
};
