/* ==========================================================================
   UnivMeet — lapisan jaringan (native WebSocket)
   Pengganti Socket.IO: API-nya sama (on/emit/disconnect) supaya app.js
   tidak perlu diubah banyak, tapi protokolnya WebSocket polos -> bisa jalan
   di Node (ws) maupun Cloudflare Workers (Durable Object).
   ========================================================================== */
(() => {
  'use strict';

  class WSClient {
    constructor(url) {
      this.url = url;
      this.ws = null;
      this.handlers = new Map();
      this.acks = new Map();
      this.nextId = 1;
      this.queue = [];
      this.closedByUs = false;
      this.retry = 0;
      this.connect();
    }

    connect() {
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        this.scheduleReconnect();
        return;
      }
      this.ws = ws;

      ws.onopen = () => {
        this.retry = 0;
        const q = this.queue.splice(0);
        for (const frame of q) {
          try { ws.send(frame); } catch (_) {}
        }
        this.fire('connect');
      };

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (!msg || !msg.e) return;
        if (msg.e === 'ack') {
          const cb = this.acks.get(msg.id);
          if (cb) {
            this.acks.delete(msg.id);
            cb(msg.d);
          }
          return;
        }
        this.fire(msg.e, msg.d);
      };

      ws.onclose = () => {
        this.fire('disconnect');
        if (!this.closedByUs) this.scheduleReconnect();
      };

      ws.onerror = () => {
        try { ws.close(); } catch (_) {}
      };
    }

    scheduleReconnect() {
      const delay = Math.min(8000, 500 * Math.pow(1.6, this.retry++));
      setTimeout(() => {
        if (!this.closedByUs) this.connect();
      }, delay);
    }

    fire(event, data) {
      const list = this.handlers.get(event);
      if (!list) return;
      for (const cb of list.slice()) {
        try { cb(data); } catch (err) { console.error('[ws] handler error', event, err); }
      }
    }

    on(event, cb) {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event).push(cb);
      return this;
    }

    emit(event, data, ack) {
      const frame = { e: event, d: data };
      if (typeof ack === 'function') {
        const id = this.nextId++;
        this.acks.set(id, ack);
        frame.id = id;
      }
      const payload = JSON.stringify(frame);
      if (this.ws && this.ws.readyState === 1) {
        try { this.ws.send(payload); } catch (_) { this.queue.push(payload); }
      } else {
        this.queue.push(payload);
      }
      return this;
    }

    disconnect() {
      this.closedByUs = true;
      try { if (this.ws) this.ws.close(); } catch (_) {}
    }
  }

  window.WSClient = WSClient;
})();
