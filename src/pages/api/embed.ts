import type { APIRoute } from 'astro';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { VAULT_EMBEDS } from '../../lib/tasks';

export const prerender = false;

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
  pdf: 'application/pdf',
};

export const GET: APIRoute = ({ url }) => {
  const file = url.searchParams.get('file');
  if (!file) return new Response('file requerido', { status: 400 });

  // Path traversal: resolver dentro de VAULT_EMBEDS solamente
  const fullPath = resolve(join(VAULT_EMBEDS, file));
  if (!fullPath.startsWith(resolve(VAULT_EMBEDS) + '/') && fullPath !== resolve(VAULT_EMBEDS)) {
    return new Response('forbidden', { status: 403 });
  }
  if (!existsSync(fullPath)) return new Response('no existe', { status: 404 });
  const stat = statSync(fullPath);
  if (!stat.isFile()) return new Response('no es archivo', { status: 400 });

  const ext = file.split('.').pop()?.toLowerCase() ?? '';
  const contentType = MIME[ext] ?? 'application/octet-stream';

  const stream = createReadStream(fullPath);
  return new Response(stream as unknown as ReadableStream, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(stat.size),
      'Cache-Control': 'public, max-age=86400',
    },
  });
};
