/**
 * Pages Function: /config — daftar STUN/TURN untuk browser.
 */

import protocol from '../lib/protocol.js';

const { iceServersFromEnv } = protocol;

export async function onRequest(context) {
  const { env } = context;
  return new Response(JSON.stringify({ iceServers: iceServersFromEnv(env), maxPeers: 8 }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
