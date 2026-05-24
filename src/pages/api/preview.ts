import type { APIRoute } from 'astro';
import { marked } from 'marked';

export const prerender = false;

const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov)$/i;
const AUDIO_EXT = /\.(mp3|m4a|wav|ogg)$/i;

function resolveObsidianEmbeds(md: string): string {
  return md.replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, name, alt) => {
    const fn = String(name).trim();
    const safe = fn.replace(/"/g, '&quot;');
    const altText = (alt ?? fn).trim().replace(/"/g, '&quot;');
    if (IMG_EXT.test(fn))   return `<img src="/api/embed?file=${encodeURIComponent(fn)}" alt="${altText}" loading="lazy" />`;
    if (VIDEO_EXT.test(fn)) return `<video src="/api/embed?file=${encodeURIComponent(fn)}" controls></video>`;
    if (AUDIO_EXT.test(fn)) return `<audio src="/api/embed?file=${encodeURIComponent(fn)}" controls></audio>`;
    return `<span class="wikilink">📄 ${safe}</span>`;
  })
  .replace(/(^|[^!])\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, prev, name, alt) => {
    const display = (alt ?? name).trim().replace(/[<>]/g, '');
    return `${prev}<span class="wikilink">🔗 ${display}</span>`;
  });
}

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.body !== 'string') {
    return new Response(JSON.stringify({ error: 'body string requerido' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  const pre = resolveObsidianEmbeds(body.body);
  const html = marked.parse(pre, { async: false }) as string;
  return new Response(JSON.stringify({ html }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};
