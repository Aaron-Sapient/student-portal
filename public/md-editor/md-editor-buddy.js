/* ============================================================================
   md-editor-buddy.js — optional pixel-cat companion for md-editor (vanilla, no
   deps; the md-editor-collab.js pattern: a sidecar the host opts into).

   The cat is Aaron's Tasks Cat. Sprite art (PAL / postures / expressions /
   emotes) is ported VERBATIM from the canonical art reference:
   "Personal Dashboard/cat_preview.html" — change the art there first, then
   re-port; don't fork the pixels here.

   The buddy is AMBIENT AND SILENT: it reacts to typing, idles, plays, sleeps.
   It never emits words and never touches the document. EGG-1 (features-log):
   fixed position (no layout shift), reduced-motion respected, dismissible.

   API:
     const buddy = MarkdownBuddy.attach(ed, {
       left?: 14, bottom?: 48,       // px, fixed; default bottom-LEFT (bottom-right
                                     // belongs to host pill rows in both known hosts)
       scale?: 5,                    // pixel size
       defaultVisible?: false,      // first-run visibility (persisted after that)
       storageKey?: "mde-buddy",    // localStorage key for visibility
     });
     buddy.show() / .hide() / .toggle() / .isVisible()
     buddy.celebrate()   // one short happy+sparkle burst (sprint end etc.)
     buddy.destroy()
   Typing is observed via ed.onChange() (additive collab hook — never steals the
   host's onInput). Typical host wiring: makeEditor/makeTabs `atCommands:
   [{ name:"buddy", label:"Buddy", sub:"a little company", run:()=>buddy.toggle() }]`.
   ============================================================================ */
(function () {
  "use strict";

  /* ---- art, ported verbatim from cat_preview.html ---- */
  const PAL = {
    'K': { l: '#201d19', d: '#ece9e0' },   // cat — black by day, white by night
    'E': { l: '#8ad17f', d: '#7cf08a' },   // eye — green (glows at night)
    'N': { l: '#e58fa6', d: '#e58fa6' },   // nose — dusty pink
    'C': { l: '#e8893a', d: '#e8893a' },   // moth (flower-center orange)
    'm': { l: '#8c8478', d: '#8c8478' },   // closed-eye / mouth line
    'o': { l: '#6a6458', d: '#d8d2c6' },   // emote glyph (?, z, !, sparkle)
    'j': { l: '#463f37', d: '#cfc9bd' },   // tail seam
  };
  const HEAD = [
    ".K........K...",
    ".KK......KK...",
    ".KKKK..KKKK...",
    ".KKKKKKKKKK...",
    "KKKKKKKKKKKK..",
    "KKKKKKKKKKKK..",
    "KKKKKKKKKKKK..",
    "KKKKKKKKKKKK..",
    "KKKKKKKKKKKK..",
  ];
  const POSTURES = {
    wrapped: HEAD.concat([
      ".KKKKKKKKKK...",
      ".KKKKKKKKKKK..",
      ".KKKKKKKKKKj..",
      ".jKKKKKKKjjj..",
      ".jjjjjjjjjjj..",
      "..jjjjjjjjj...",
    ]),
    loaf: HEAD.concat([
      ".KKKKKKKKKK...",
      ".KKKKKKKKKKK..",
      ".KKKKKKKKKKKK.",
      ".KKKKKKKKKKKK.",
      "..KKKKKKKKKK..",
      "...KKKKKKKK...",
    ]),
    paws: HEAD.concat([
      ".KKKKKKKKKK...",
      ".KKKKKKKKKKK..",
      ".KKKKKKKKKKKK.",
      ".KKKKKKKKKKKK.",
      "..KKKKKKKKKK..",
      "...KK..KK.....",
    ]),
    pawing: [
      ".K........K...",
      ".KK......KK..C",
      ".KKKK..KKKK.CC",
      ".KKKKKKKKKK..C",
      "KKKKKKKKKKKK..",
      "KKKKKKKKKKKK..",
      "KKKKKKKKKKKK..",
      "KKKKKKKKKKKK..",
      "KKKKKKKKKKKK..",
      ".KKKKKKKKKKKK.",
      ".KKKKKKKKKK.KK",
      ".KKKKKKKKKK...",
      "..KKKKKKKKKK..",
      "...KKKKKKKK...",
    ],
  };
  const EXPR = {
    content:  { face: { 5: "KKEEKKKKEEKK", 6: "KKEEKKKKEEKK", 7: "KKKKKNNKKKKK" } },
    happy:    { face: { 5: "KKKmKKKKmKKK", 6: "KKm.mKKm.mKK", 7: "KKKKKNNKKKKK" }, emote: "happy" },
    confused: { face: { 5: "KKEEKKKKKKKK", 6: "KKEEKKKmmmKK", 7: "KKKKKNNKKKKK" }, emote: "confused" },
    upset:    { face: { 5: "KKE......EKK", 6: "KKKEKKKKEKKK", 8: "KKKKmmmmKKKK" }, emote: "upset" },
    asleep:   { face: { 5: "KKmmKKKKmmKK" }, emote: "sleeping" },
  };
  const EMOTES = {
    happy:    [".o.", "ooo", ".o."],
    confused: ["ooo", "o.o", "..o", ".o.", ".o."],
    upset:    ["o", "o", "o", ".", "o"],
    sleeping: ["ooo", "..o", ".o.", "ooo"],
  };

  function blank(w, h) { return Array.from({ length: h }, () => Array(w).fill('.')); }
  function stamp(grid, sprite, ox, oy) {
    for (let y = 0; y < sprite.length; y++)
      for (let x = 0; x < sprite[y].length; x++) {
        const c = sprite[y][x];
        if (c === '.') continue;
        const gy = oy + y, gx = ox + x;
        if (gy < 0 || gy >= grid.length || gx < 0 || gx >= grid[0].length) continue;
        grid[gy][gx] = c;
      }
  }
  function composeCat(posture, expr) {
    const body = POSTURES[posture] || POSTURES.loaf, g = body.map(r => r.split(''));
    const e = EXPR[expr] || EXPR.content;
    for (const k in e.face) { const s = e.face[k]; if (!g[+k]) continue; for (let i = 0; i < s.length; i++) if (s[i] !== '.') g[+k][i] = s[i]; }
    return g.map(r => r.join(''));
  }
  // card = emote band (6 rows) above a bottom-aligned cat; W16 fits every posture
  const CW = 16, EMOTE_H = 6, CH = EMOTE_H + 15;
  function catCard(posture, expr, emoteOverride) {
    const cat = composeCat(posture, expr), g = blank(CW, CH);
    stamp(g, cat, 1, CH - cat.length);
    const em = emoteOverride || (EXPR[expr] || {}).emote;
    if (em && EMOTES[em]) stamp(g, EMOTES[em], 11, EMOTE_H - EMOTES[em].length);
    return g;
  }
  function drawGrid(canvas, grid, scale, dark) {
    const w = grid[0].length, h = grid.length;
    canvas.width = w * scale; canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = grid[y][x]; if (c === '.') continue;
      const p = PAL[c]; if (!p) continue;
      ctx.fillStyle = dark ? p.d : p.l;
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }

  /* ---- the buddy itself ---- */
  const TYPING_SETTLE_MS = 4000;        // typing → idle after this quiet gap
  const SLEEP_MS = 7 * 60 * 1000;       // idle → asleep (LONG on purpose: a thinking
                                        // pause must never read as abandonment)
  const PLAY_MIN_IDLE_MS = 45 * 1000;   // idle this long before moth-play can start
  const PLAY_MS = 6000;

  let cssInjected = false;
  function injectCSS() {
    if (cssInjected) return; cssInjected = true;
    const st = document.createElement('style');
    st.textContent =
      '.mde-buddy{position:fixed;z-index:250;image-rendering:pixelated;cursor:pointer;user-select:none;}' +
      '.mde-buddy.mde-buddy-bounce{animation:mdeBuddyBounce .55s ease-in-out infinite;}' +
      '@keyframes mdeBuddyBounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}' +
      '@media (prefers-reduced-motion: reduce){.mde-buddy.mde-buddy-bounce{animation:none;}}';
    document.head.appendChild(st);
  }

  function attach(ed, opts) {
    opts = opts || {};
    injectCSS();
    const storageKey = opts.storageKey || 'mde-buddy';
    const scale = opts.scale || 5;

    const cv = document.createElement('canvas');
    cv.className = 'mde-buddy';
    cv.style.left = (opts.left != null ? opts.left : 14) + 'px';
    cv.style.bottom = (opts.bottom != null ? opts.bottom : 48) + 'px';
    cv.title = 'mrrp';
    document.body.appendChild(cv);

    // state machine: typing | idle | play | asleep | celebrate
    let state = 'idle', lastInput = Date.now(), idleSince = Date.now();
    let playUntil = 0, celebrateUntil = 0, blinkUntil = 0;
    let tick = null, visible = false, destroyed = false;

    function isDark() {
      const r = document.documentElement;
      if (r.classList.contains('mde-dark')) return true;
      if (r.classList.contains('mde-light')) return false;
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }
    function frame() {
      if (state === 'celebrate') return { p: 'paws', e: 'happy', em: 'happy' };
      if (state === 'asleep')    return { p: 'loaf', e: 'asleep', em: 'sleeping' };
      if (state === 'play')      return { p: 'pawing', e: 'happy', em: null };
      if (state === 'typing')    return { p: 'paws', e: 'happy', em: null };
      // idle — a blink briefly borrows the closed-eye row
      return { p: 'wrapped', e: (Date.now() < blinkUntil) ? 'asleep' : 'content', em: null };
    }
    function render() {
      if (!visible) return;
      const f = frame();
      drawGrid(cv, catCard(f.p, f.e, f.em), scale, isDark());
      cv.classList.toggle('mde-buddy-bounce', state === 'typing' || state === 'celebrate');
    }
    function setState(s) { if (state !== s) { state = s; if (s === 'idle') idleSince = Date.now(); render(); } }

    function poke() {                       // any local edit
      lastInput = Date.now();
      if (state !== 'celebrate') setState('typing');
    }
    function step() {
      const now = Date.now();
      if (state === 'celebrate') { if (now >= celebrateUntil) setState(now - lastInput < TYPING_SETTLE_MS ? 'typing' : 'idle'); return; }
      if (state === 'typing' && now - lastInput > TYPING_SETTLE_MS) { setState('idle'); return; }
      if (state === 'play' && now >= playUntil) { setState('idle'); return; }
      if (state === 'idle') {
        if (now - lastInput > SLEEP_MS) { setState('asleep'); return; }
        // occasional charm so stillness reads as company, not a paused monitor
        if (now - idleSince > PLAY_MIN_IDLE_MS && Math.random() < 1 / 90) { playUntil = now + PLAY_MS; setState('play'); return; }
        if (Date.now() >= blinkUntil && Math.random() < 1 / 12) { blinkUntil = now + 260; render(); setTimeout(render, 300); }
      }
    }

    const unsub = (ed && typeof ed.onChange === 'function') ? ed.onChange(poke) : function () {};

    // theme flips (manual toggle or OS) → repaint in the other palette
    const mo = new MutationObserver(render);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    let mq = null, mqCb = null;
    if (window.matchMedia) {
      mq = window.matchMedia('(prefers-color-scheme: dark)');
      mqCb = render;
      if (mq.addEventListener) mq.addEventListener('change', mqCb);
    }

    cv.addEventListener('click', () => {    // petting is allowed
      celebrateUntil = Date.now() + 1400; setState('celebrate'); render();
    });

    function show() {
      if (destroyed || visible) return;
      visible = true; cv.style.display = '';
      try { localStorage.setItem(storageKey, '1'); } catch (_) {}
      if (!tick) tick = setInterval(step, 1000);
      setState('idle'); render();
    }
    function hide() {
      if (destroyed || !visible) return;
      visible = false; cv.style.display = 'none';
      try { localStorage.setItem(storageKey, '0'); } catch (_) {}
      if (tick) { clearInterval(tick); tick = null; }
    }
    function toggle() { visible ? hide() : show(); }
    function celebrate() {
      if (!visible) return;
      celebrateUntil = Date.now() + 3000; setState('celebrate'); render();
    }
    function destroy() {
      if (destroyed) return; destroyed = true;
      hide(); unsub(); mo.disconnect();
      if (mq && mqCb && mq.removeEventListener) mq.removeEventListener('change', mqCb);
      cv.remove();
    }

    // first paint: persisted visibility wins; else the host's default (egg = hidden)
    let startVisible = opts.defaultVisible === true;
    try { const s = localStorage.getItem(storageKey); if (s === '1') startVisible = true; else if (s === '0') startVisible = false; } catch (_) {}
    cv.style.display = 'none';
    if (startVisible) show();

    return { show, hide, toggle, celebrate, destroy, isVisible: () => visible };
  }

  window.MarkdownBuddy = { attach };
})();
