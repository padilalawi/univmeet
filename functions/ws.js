/**
 * Pages Function: /ws  — WebSocket signaling
 * Meneruskan koneksi ke Durable Object milik Worker `univmeet` (binding ROOMS).
 */

import protocol from '../lib/protocol.js';

const { cleanRoomId } = protocol;

const CORS = {
  'access-control-allow-origin': '*',
  'cache-control': 'no-store',
};

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const room = cleanRoomId(url.searchParams.get('room'));

  if (!room) {
    return new Response(JSON.stringify({ ok: false, error: 'room wajib diisi' }), {
      status: 400,
      headers: { 'content-type': 'application/json', ...CORS },
    });
  }

  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response(JSON.stringify({ ok: true, ws: 'butuh upgrade' }), {
      headers: { 'content-type': 'application/json', ...CORS },
    });
  }

  const id = env.ROOMS.idFromName(room);
  const stub = env.ROOMS.get(id);
  return stub.fetch(request);
}
