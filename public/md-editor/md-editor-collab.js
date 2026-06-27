/* ============================================================================
   md-editor-collab.js — OPT-IN, backend-agnostic Yjs binding for md-editor.

   This is the ONLY file that references Yjs. The host loads Yjs (window.Y) and a
   y-protocols Awareness, creates a Y.Doc, sets a join-order-derived doc.clientID
   (lower = higher YATA priority for concurrent same-position inserts), then calls:

       const binding = window.MarkdownCollab(ed, {
         ytext,            // Y.Text  (e.g. doc.getText('t'))
         awareness,        // y-protocols Awareness over the SAME doc
         user: { id, name, color },
         undoManager,      // optional pre-made Y.UndoManager; else one is created
       });

   `ed` is a makeEditor() instance (or makeTabs()). The editor stays the single source
   of truth — `text` — and this binding only translates the rest:

   TABS / setText — a binding does NOT survive a tab switch. selectTab()/setText() re-seed
   the SAME editor with a DIFFERENT document, so a binding bound to getEditor() (or to a
   makeTabs instance) would then point at the wrong Y.Text. The host MUST destroy() the old
   binding and bindCollab() to the newly-active tab's Y.Text on every tab change. As a safety
   net we subscribe to ed.onReseed and reset `last` (+ re-pin awareness) so a stray setText
   can't clobber the CURRENT shared doc with the new tab's text — but that only prevents
   corruption; it does NOT retarget the binding. Only destroy()+rebind does that.

     • Local → Y : ed.onChange → diff(last, current) → one {index,del,ins} → ytext
                   inside a transaction tagged LOCAL_ORIGIN (so we never echo our own).
     • Y → Local : ytext.observe → walk the delta → ed.applyRemote(...) per op
                   (skipping LOCAL_ORIGIN transactions). No echo: applyRemote fires
                   neither onInput nor onChange.
     • Undo      : a Y.UndoManager scoped to LOCAL_ORIGIN, wired to the editor's
                   Cmd-Z/Y via ed.setUndoHandler — so undo only affects YOUR edits.
     • Cursors   : awareness 'cursor' = ABSOLUTE offsets {a,b} (see note below).
                   Remote states → ed.setRemoteCarets([{id,name,color,a,b}]).
     • Presence  : the set of awareness states carrying a `user` field. getPeers()
                   + on('peers', cb). Native "only when someone's in the doc" —
                   awareness only holds live-connected clients.

   CURSOR ENCODING — absolute offsets (the spec's accepted fallback). The editor
   funnels typing as setCaret(newPos) BEFORE the onChange that updates the Y.Text,
   so a RelativePosition captured at caret-publish time would resolve against a
   pre-edit Y.Text and land one char off until the next awareness tick. Absolute
   offsets dodge that: the receiver maps them against its own (converged) text, and
   the overlay re-pins on every render(). Concurrent drift self-corrects on the next
   awareness update. (To upgrade to RelativePositions later, publish inside onChange
   after the transaction, not in onCaret.)

   binding API: { undo(), redo(), getPeers(), on(evt,cb), off(evt,cb), destroy() }
   ============================================================================ */
(function () {
  "use strict";

  // Module-private origin tag for our own transactions. Shared by all bindings in
  // this module — fine, because origin is compared WITHIN each doc, and each editor
  // has its own doc. Our doc's observer skips it (no self-echo); a peer's doc sees a
  // different (relay) origin and applies it.
  var LOCAL_ORIGIN = { mde: "local" };

  // Single-range diff via common prefix/suffix. Returns {index, del, ins} or null.
  // Granularity doesn't matter for convergence — Yjs merges character-level either way.
  function diff(oldStr, newStr) {
    if (oldStr === newStr) return null;
    var oLen = oldStr.length, nLen = newStr.length;
    var min = oLen < nLen ? oLen : nLen;
    var start = 0;
    while (start < min && oldStr.charCodeAt(start) === newStr.charCodeAt(start)) start++;
    var oEnd = oLen, nEnd = nLen;
    while (oEnd > start && nEnd > start && oldStr.charCodeAt(oEnd - 1) === newStr.charCodeAt(nEnd - 1)) { oEnd--; nEnd--; }
    return { index: start, del: oEnd - start, ins: newStr.slice(start, nEnd) };
  }

  // Tiny event emitter for the binding ('peers').
  function emitter() {
    var map = Object.create(null);
    return {
      on: function (evt, cb) { (map[evt] || (map[evt] = [])).push(cb); },
      off: function (evt, cb) { var a = map[evt]; if (!a) return; var i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); },
      emit: function (evt, payload) { var a = map[evt]; if (!a) return; for (var i = 0; i < a.length; i++) { try { a[i](payload); } catch (_) {} } },
      clear: function () { map = Object.create(null); }
    };
  }

  function bindCollab(ed, opts) {
    opts = opts || {};
    var Y = window.Y;
    if (!Y) throw new Error("MarkdownCollab: window.Y (Yjs) is not loaded.");
    var ytext = opts.ytext;
    if (!ytext) throw new Error("MarkdownCollab: opts.ytext (a Y.Text) is required.");
    var ydoc = ytext.doc;
    if (!ydoc) throw new Error("MarkdownCollab: the Y.Text is not attached to a Y.Doc.");
    var awareness = opts.awareness || null;
    var user = opts.user || { id: String(ydoc.clientID), name: "Anon", color: "#386840" };
    var ev = emitter();

    // ---- seed the editor from the shared doc ----
    var last = ytext.toString();
    ed.setText(last);
    last = ytext.toString();

    // ---- Local → Y : diff the editor against `last`, write the single range ----
    var offChange = ed.onChange(function () {
      if (applyingRemote) return;   // belt & suspenders; applyRemote also gates onChange
      var cur = ed.getText();
      var d = diff(last, cur);
      if (!d) return;
      ydoc.transact(function () {
        if (d.del) ytext.delete(d.index, d.del);
        if (d.ins) ytext.insert(d.index, d.ins);
      }, LOCAL_ORIGIN);
      last = ytext.toString();
    });

    // ---- Y → Local : translate the Yjs delta to ed.applyRemote ops (left→right) ----
    var applyingRemote = false;
    function onYText(evt) {
      if (evt.transaction.origin === LOCAL_ORIGIN) return;   // our own edit — already in the editor
      applyingRemote = true;
      try {
        var idx = 0, delta = evt.delta;
        for (var i = 0; i < delta.length; i++) {
          var op = delta[i];
          if (op.retain != null) { idx += op.retain; }
          else if (op.insert != null) {
            var ins = (typeof op.insert === "string") ? op.insert : "";
            ed.applyRemote(idx, 0, ins); idx += ins.length;
          } else if (op.delete != null) {
            ed.applyRemote(idx, op.delete, "");
          }
        }
      } finally {
        applyingRemote = false;
        last = ytext.toString();
      }
    }
    ytext.observe(onYText);

    // ---- Undo : a Y.UndoManager scoped to OUR origin, wired to the editor's keys ----
    var ownUndo = false, undoManager = opts.undoManager || null;
    if (!undoManager) {
      undoManager = new Y.UndoManager(ytext, { trackedOrigins: new Set([LOCAL_ORIGIN]) });
      ownUndo = true;
    }
    ed.setUndoHandler(function () { undoManager.undo(); }, function () { undoManager.redo(); });

    // ---- Cursors + presence (awareness) ----
    var offCaret = function () {};
    function computeFromAwareness() {
      if (!awareness) return;
      var carets = [], peers = [];
      var states = awareness.getStates();
      states.forEach(function (state, clientId) {
        if (!state || !state.user) return;
        peers.push({ id: String(clientId), name: state.user.name, color: state.user.color, self: clientId === awareness.clientID });
        if (clientId === awareness.clientID) return;   // never draw our own remote caret
        if (!state.cursor) return;                     // peer hasn't placed a caret yet
        var a = state.cursor.a, b = state.cursor.b;
        if (a == null) return;
        carets.push({ id: String(clientId), name: state.user.name, color: state.user.color, a: a, b: (b == null ? a : b) });
      });
      ed.setRemoteCarets(carets);
      ev.emit("peers", peers);
    }
    function onAwareness() { computeFromAwareness(); }
    if (awareness) {
      awareness.setLocalStateField("user", user);
      offCaret = ed.onCaret(function (a, b) {
        awareness.setLocalStateField("cursor", { a: a, b: b });
      });
      awareness.on("change", onAwareness);
      // publish our current caret + render any peers already present
      var sel = ed.getSelection ? ed.getSelection() : [0, 0];
      awareness.setLocalStateField("cursor", { a: sel[0], b: sel[1] });
      computeFromAwareness();
    }

    // ---- Re-baseline on a host setText() (e.g. a tab switch) WITHOUT emitting an op ----
    // setText replaces the editor's whole text but does NOT fire onChange. Without this, `last`
    // would stay at the pre-setText content and the next keystroke would diff against it and
    // clobber the shared Y.Text with the new tab's text (silent data loss for every peer). We
    // reset `last` so a subsequent local edit produces only that edit's op against THIS doc.
    // (This does NOT retarget the binding to a different Y.Text — for true multi-tab collab the
    // host must destroy() + bindCollab() to the new tab's Y.Text; see the file header.)
    var offReseed = (typeof ed.onReseed === "function") ? ed.onReseed(function () {
      if (applyingRemote) return;   // our own applyRemote never calls setText, but be safe
      last = ed.getText();
      if (awareness) {
        var s = ed.getSelection ? ed.getSelection() : [0, 0];
        awareness.setLocalStateField("cursor", { a: s[0], b: s[1] });
      }
    }) : function () {};

    function getPeers() {
      if (!awareness) return [];
      var peers = [];
      awareness.getStates().forEach(function (state, clientId) {
        if (state && state.user) peers.push({ id: String(clientId), name: state.user.name, color: state.user.color, self: clientId === awareness.clientID });
      });
      return peers;
    }

    var destroyed = false;
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      try { offChange(); } catch (_) {}
      try { offCaret(); } catch (_) {}
      try { offReseed(); } catch (_) {}
      try { ytext.unobserve(onYText); } catch (_) {}
      try { ed.setUndoHandler(null, null); } catch (_) {}
      if (awareness) {
        try { awareness.off("change", onAwareness); } catch (_) {}
        try { awareness.setLocalState(null); } catch (_) {}   // drop our presence + cursor from peers
      }
      try { ed.setRemoteCarets([]); } catch (_) {}
      if (ownUndo) { try { undoManager.destroy(); } catch (_) {} }
      ev.clear();
    }

    return {
      undo: function () { undoManager.undo(); },
      redo: function () { undoManager.redo(); },
      getPeers: getPeers,
      undoManager: undoManager,
      on: ev.on,
      off: ev.off,
      destroy: destroy,
    };
  }

  if (typeof window !== "undefined") window.MarkdownCollab = bindCollab;
})();
