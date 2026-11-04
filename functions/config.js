/**
 * Pages Function: /config — daftar STUN/TURN untuk browser.
 */

import protocol from '../lib/protocol.js';

const { iceServersFromEnv } = protocol;

export async function onRequest(context) {
  const { env } = context;
  const n = Number(env && env.MAX_PEERS);
  const maxPeers = Number.isFinite(n) ? Math.max(2, Math.min(30, n)) : 20;
  return new Response(JSON.stringify({ iceServers: iceServersFromEnv(env), maxPeers }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
