/* ============================================================================
   supabaseYjsProvider.js — a Yjs network provider over Supabase Realtime.

   Stage-3 transport for md-editor live collaboration. It owns a Y.Doc + a
   y-protocols Awareness and synchronises them with every other client on a
   per-document-tab Realtime channel using BROADCAST (Yjs updates + awareness)
   and PRESENCE (join order, for seeding). It does NOT persist anything itself —
   persistence stays server-side via the existing /api/writing/save debounce.

   The md-editor binding (window.MarkdownCollab) consumes `provider.ytext` +
   `provider.awareness`; this class just moves their bytes between clients.

   SEEDING (decision: reuse body_md). A fresh Y.Doc is empty. On join we run a
   Yjs sync handshake (request peers' state; apply what comes back). After a
   short settle window, if the shared text is STILL empty, the FIRST joiner
   (lowest presence join time, tie-broken by clientID) seeds it from the
   server's body_md — exactly once — and the insert propagates to everyone.
   A peer that already synced non-empty content never seeds. (Residual edge: if
   two cold clients can't see each other in presence within the settle window
   they could both seed → duplicated text. Rare for 2-person essay editing; the
   window is generous. A yjs_snapshot column would remove it entirely — deferred.)

   GRACEFUL DEGRADATION. If Realtime never connects, the settle timer still fires,
   presence shows only us, so we seed from body_md and edit solo — the editor and
   server save path are unaffected. Live collab is purely additive.

   FIRST-PERSON-WINS. Yjs keeps every concurrent insert (YATA) — nobody loses
   text regardless of clientID. We keep Yjs's default random clientID for
   collision safety; exact same-character ties resolve deterministically by
   clientID (either order is safe). Presence join order is what we use where it
   actually matters: electing the single seeder.
   ============================================================================ */
import * as Y from 'yjs';
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';

const SETTLE_MS = 900; // wait for sync from peers before deciding to seed

// base64 <-> Uint8Array, working in both the browser (btoa/atob) and Node (Buffer).
function u8ToB64(u8) {
  if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
function b64ToU8(b) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b, 'base64'));
  const s = atob(b);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

export class SupabaseYjsProvider {
  /**
   * @param {SupabaseClient} supabase  a Realtime-capable client (publishable key)
   * @param {object} opts
   * @param {string} opts.docId
   * @param {string} opts.tabId
   * @param {{id:string,name:string,color:string}} opts.user
   * @param {() => string} [opts.seedText]  returns the persisted body_md to seed if we're first
   */
  constructor(supabase, { docId, tabId, user, seedText }) {
    this.supabase = supabase;
    this.user = user || { id: 'anon', name: 'Anon', color: '#386840' };
    this.seedText = typeof seedText === 'function' ? seedText : () => '';
    this.channelName = `mde:${docId}:${tabId}`;
    this.joinedAt = nowMs();

    this.doc = new Y.Doc();
    this.ytext = this.doc.getText('t');
    this.awareness = new Awareness(this.doc);
    this.awareness.setLocalStateField('user', this.user);

    this.channel = null;
    this.synced = false;
    this.destroyed = false;
    this._settleTimer = null;
    this._listeners = Object.create(null);

    // Local doc edits → broadcast. Skip updates WE applied from the network
    // (origin === this) to avoid an echo loop.
    this._onDocUpdate = (update, origin) => {
      if (origin === this || this.destroyed) return;
      this._send('y', update);
    };
    // Local awareness changes → broadcast (skip remote-applied ones).
    this._onAwarenessUpdate = ({ added, updated, removed }, origin) => {
      if (origin === this || this.destroyed) return;
      const changed = added.concat(updated, removed);
      this._send('aw', encodeAwarenessUpdate(this.awareness, changed));
    };
    this.doc.on('update', this._onDocUpdate);
    this.awareness.on('update', this._onAwarenessUpdate);
  }

  on(evt, cb) {
    (this._listeners[evt] || (this._listeners[evt] = [])).push(cb);
    return () => this.off(evt, cb);
  }
  off(evt, cb) {
    const a = this._listeners[evt];
    if (!a) return;
    const i = a.indexOf(cb);
    if (i >= 0) a.splice(i, 1);
  }
  _emit(evt, payload) {
    const a = this._listeners[evt];
    if (!a) return;
    for (const cb of a.slice()) { try { cb(payload); } catch (_) {} }
  }

  _send(event, u8) {
    if (!this.channel) return;
    try {
      this.channel.send({ type: 'broadcast', event, payload: { d: u8ToB64(u8) } });
    } catch (_) {}
  }

  start() {
    if (this.channel || this.destroyed) return this;
    const ch = this.supabase.channel(this.channelName, {
      config: { broadcast: { self: false, ack: false }, presence: { key: String(this.doc.clientID) } },
    });
    this.channel = ch;

    ch.on('broadcast', { event: 'y' }, ({ payload }) => {
      if (!payload?.d || this.destroyed) return;
      Y.applyUpdate(this.doc, b64ToU8(payload.d), this); // origin=this → no re-broadcast
    });
    ch.on('broadcast', { event: 'aw' }, ({ payload }) => {
      if (!payload?.d || this.destroyed) return;
      applyAwarenessUpdate(this.awareness, b64ToU8(payload.d), this);
    });
    // A peer asks for current state (sends its state vector) → reply with the diff
    // it's missing, plus our awareness so its cursors light up immediately.
    ch.on('broadcast', { event: 'sync-req' }, ({ payload }) => {
      if (this.destroyed) return;
      const sv = payload?.sv ? b64ToU8(payload.sv) : undefined;
      this._send('y', Y.encodeStateAsUpdate(this.doc, sv));
      const keys = Array.from(this.awareness.getStates().keys());
      if (keys.length) this._send('aw', encodeAwarenessUpdate(this.awareness, keys));
    });

    ch.on('presence', { event: 'sync' }, () => this._emitPeers());
    ch.on('presence', { event: 'join' }, () => this._emitPeers());
    ch.on('presence', { event: 'leave' }, () => this._emitPeers());

    ch.subscribe((status) => {
      this._emit('status', status);
      if (status === 'SUBSCRIBED') {
        ch.track({ at: this.joinedAt, cid: this.doc.clientID, user: this.user });
        // ask peers for their state, and announce our presence/awareness
        this.channel.send({
          type: 'broadcast',
          event: 'sync-req',
          payload: { sv: u8ToB64(Y.encodeStateVector(this.doc)) },
        });
        this._send('aw', encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        // Degrade to solo: still seed + edit locally. Don't block the settle timer.
      }
    });

    // After the settle window, seed if the doc is still cold and we're first.
    this._settleTimer = setTimeout(() => this._maybeSeed(), SETTLE_MS);
    return this;
  }

  _maybeSeed() {
    if (this.destroyed) return;
    this._settleTimer = null;
    if (this.ytext.length === 0 && this._amSeeder()) {
      const seed = this.seedText() || '';
      if (seed) this.ytext.insert(0, seed); // default origin → broadcasts to peers
    }
    if (!this.synced) {
      this.synced = true;
      this._emit('synced');
    }
  }

  // Seeder = lowest presence join time (tie-broken by clientID) among all present.
  // With no channel / no peers, presenceState is empty → we are trivially the seeder.
  _amSeeder() {
    let present = [];
    try {
      const st = this.channel ? this.channel.presenceState() : {};
      present = Object.values(st).flat();
    } catch (_) {}
    const me = { at: this.joinedAt, cid: this.doc.clientID };
    return present.every((p) => {
      const at = p?.at ?? Infinity;
      const cid = p?.cid ?? Infinity;
      return at > me.at || (at === me.at && cid >= me.cid);
    });
  }

  _emitPeers() {
    const peers = [];
    this.awareness.getStates().forEach((state, clientId) => {
      if (state && state.user) {
        peers.push({
          id: String(clientId),
          name: state.user.name,
          color: state.user.color,
          self: clientId === this.awareness.clientID,
        });
      }
    });
    this._emit('peers', peers);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this._settleTimer) { clearTimeout(this._settleTimer); this._settleTimer = null; }
    try { this.doc.off('update', this._onDocUpdate); } catch (_) {}
    try { this.awareness.off('update', this._onAwarenessUpdate); } catch (_) {}
    // Tell peers we left (best-effort) before tearing the socket down; even if the
    // broadcast is dropped, y-protocols GCs our stale awareness after its timeout.
    try { removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy'); } catch (_) {}
    try {
      if (this.channel) {
        this.channel.untrack?.();
        this.supabase.removeChannel(this.channel);
      }
    } catch (_) {}
    this.channel = null;
    try { this.awareness.destroy(); } catch (_) {}
    try { this.doc.destroy(); } catch (_) {}
    this._listeners = Object.create(null);
  }
}

function nowMs() {
  // wall clock for relative join ordering (seeder election only — never for identity).
  return typeof performance !== 'undefined' && performance.timeOrigin
    ? performance.timeOrigin + performance.now()
    : Date.now();
}

export default SupabaseYjsProvider;
