'use strict';
// Diagnostik: kirim join ke server (Node atau Worker) dan cetak semua balasan.
const WebSocket = require('ws');

const url = process.argv[2] || 'ws://127.0.0.1:8787/ws?room=uji-123';
const room = process.argv[3] || 'uji-123';

const ws = new WebSocket(url);
ws.on('open', () => {
  console.log('OPEN', url);
  ws.send(JSON.stringify({ e: 'join', d: { room, name: 'Tes' }, id: 1 }));
});
ws.on('message', (m) => console.log('MSG', m.toString()));
ws.on('close', (c, r) => console.log('CLOSE', c, String(r)));
ws.on('error', (e) => console.log('ERR', e.message));
setTimeout(() => { try { ws.close(); } catch (_) {} process.exit(0); }, 4000);
