/**
 * Pages Function: /healthz — status ringkas.
 */

export async function onRequest() {
  return new Response(JSON.stringify({ ok: true, runtime: 'cloudflare-pages' }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
