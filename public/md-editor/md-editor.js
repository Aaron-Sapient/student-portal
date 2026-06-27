/* ============================================================================
   md-editor.js — project-agnostic live-markdown editor (vanilla, no deps).
   `text` is the single source of truth; the DOM is a pure projection of it.
   API:  const ed = makeEditor(surface, opts)
     opts.onInput()      call (debounce it) after every content change
     opts.onSave()       called on Cmd/Ctrl-S
     opts.people         [{ name, email, accent?, accentBg?, accentBorder? }]
     opts.scrollParent   element whose scroll dismisses popovers (optional)
     opts.acceptMarkdown bool — typed markdown marks (**, *, `, ~~) are interpreted but
                         demoted to an "easter egg": they flash once on the stamp that
                         creates them, then hide and never reveal on click (headers excepted).
                         off ⇒ raw marks stay visible (classic markdown). Default on; persisted.
     ed.setText(v) / ed.getText() / ed.focus() / ed.caretToEnd() / ed.dismiss()
   See README.md for the %%comment%% syntax, tables, and Supabase wiring.
   ============================================================================ */
  function makeEditor(surface, opts) {
    opts = opts || {};
    const _hostOnInput = opts.onInput || function () {};
    const onSave = opts.onSave || function () {};
    /* ---- Stage-2 collaboration hooks (additive; every one is a no-op until a host wires it) ----
       The core editor stays byte-for-byte unchanged when no listener/caret is registered: the
       change-listener list is empty, remoteApplying is false, extUndo/extRedo are null, and the
       remote-caret overlay is never created. Verified by keeping the Stage-1 suite 100% green. */
    const changeListeners = [];   // ed.onChange(cb): fired AFTER every local mutation (not on remote apply)
    const caretListeners = [];    // ed.onCaret(cb): fired when the LOCAL caret/selection changes
    const reseedListeners = [];   // ed.onReseed(cb): fired AFTER setText() re-baselines the doc (host-driven, no echo)
    let remoteApplying = false;   // true only while applyRemote() mutates — suppresses change/caret echo
    let remoteCarets = [];        // [{id,name,color,a,b}] currently drawn in the overlay
    let caretLayer = null;        // lazily-created remote-cursor overlay (null until first non-empty list)
    let extUndo = null, extRedo = null;   // when set (collab bound), undo/redo route here (e.g. Y.UndoManager)
    // Wrapping onInput (rather than editing every call site) means the change listeners fire exactly
    // where the host's onInput already does — every local mutation, and nowhere else.
    function onInput() {
      _hostOnInput();
      if (remoteApplying) return;
      for (let i = 0; i < changeListeners.length; i++) { try { changeListeners[i](); } catch (_) {} }
    }
    function notifyCaret() {
      if (remoteApplying) return;
      for (let i = 0; i < caretListeners.length; i++) { try { caretListeners[i](selA, selB); } catch (_) {} }
    }
    // setText() is a host-driven full reset that deliberately does NOT call onInput (no echo), so a
    // collab binding would otherwise keep a stale `last` and clobber the shared doc on the next keystroke.
    // notifyReseed lets a binding re-baseline (reset its `last`, re-pin awareness) without emitting an op.
    function notifyReseed() {
      for (let i = 0; i < reseedListeners.length; i++) { try { reseedListeners[i](); } catch (_) {} }
    }
    const PEOPLE = opts.people || [];
    const scrollParent = opts.scrollParent || null;
    // self-contained HTML escape (no host dependency)
    const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g,
      c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

    /* ----- DOCS-8 invisible styling: parse + SANITIZE a @{s:…} spec -----
       A spec is "key=val;key=val". Every value is whitelisted before it ever
       reaches the DOM/clipboard, so the in-band syntax can never inject CSS. */
    const FONT_STACKS = {
      sans:    'var(--mde-sans)',
      serif:   'var(--mde-serif)',
      mono:    'var(--mde-mono)',
      poppins: '"Poppins", var(--mde-sans)',
      georgia: 'Georgia, "Times New Roman", serif',
      times:   '"Times New Roman", Times, serif',
      arial:   'Arial, Helvetica, sans-serif',
      courier: '"Courier New", ui-monospace, monospace',
    };
    function safeColor(v) {
      v = String(v == null ? "" : v).trim();
      if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return v;        // #abc / #aabbcc / #aabbccdd
      if (/^[a-zA-Z]{1,24}$/.test(v)) return v.toLowerCase(); // CSS named color
      return null;
    }
    function safeNum(v, lo, hi) { const n = parseFloat(v); return (isFinite(n) && n >= lo && n <= hi) ? n : null; }
    function parseStyleSpec(spec) {
      const out = {};
      String(spec == null ? "" : spec).split(";").forEach(part => {
        const eq = part.indexOf("="); if (eq < 0) return;
        const k = part.slice(0, eq).trim().toLowerCase(), v = part.slice(eq + 1).trim();
        if (k) out[k] = v;
      });
      return out;
    }
    // build a sanitized {prop:value} list once; reused for DOM styling AND html export
    function styleDecls(spec) {
      const m = parseStyleSpec(spec), d = [];
      let c;
      if (m.c  && (c = safeColor(m.c)))  d.push(["color", c]);
      if (m.bg && (c = safeColor(m.bg))) d.push(["background-color", c]);
      if (m.f  && FONT_STACKS[m.f])      d.push(["font-family", FONT_STACKS[m.f]]);
      if (m.sz && (c = safeNum(m.sz, 0.5, 4))) d.push(["font-size", c + "em"]);
      if (m.u === "1") d.push(["text-decoration", "underline"]);
      return d;
    }
    function applyStyleSpec(el, spec) { for (const [p, v] of styleDecls(spec)) el.style.setProperty(p, v); }
    function styleSpecToCss(spec) { return styleDecls(spec).map(([p, v]) => p + ":" + v).join(";"); }
    function styleSpecToStr(obj) {  // {c:'red', f:'poppins'} -> "c=red;f=poppins"  (empty values drop)
      return Object.keys(obj).filter(k => obj[k] != null && obj[k] !== "").map(k => k + "=" + obj[k]).join(";");
    }

    let text = "";
    let selA = 0, selB = 0;
    let leaves = [];     // { el, s, len }  — every source char lives in exactly one leaf
    let blocks = [];     // { el, s, e }    — one per source line
    let toks = [];       // { el, s, e }    — inline spans, for reveal
    let composing = false, compAt = null;
    let suppress = false;
    let undo = [], redo = [], lastType = null, lastAt = 0;
    let tocRefresh = null;   // DOCS-TOC: set by the table-of-contents feature; called after every render
    let wcRefresh = null;    // DOCS-WC:  set by the word-count feature; called after every render
    let wcCaretRefresh = null; // DOCS-WC: called on local selection change so the pill switches between the full-doc count and the highlighted-portion count
    // Markdown demotion: when acceptMd is on, emphasis marks (**, *, `, ~~) render but DON'T
    // reveal on caret entry — they flash once on the "stamp" (the keystroke that completes a new
    // token) then hide forever (asymmetric: add via chars, remove via the toolbar). Headers stay
    // on the separate block path, untouched. acceptMd off ⇒ raw marks stay shown (classic md).
    let acceptMd = (typeof opts.acceptMarkdown === "boolean") ? opts.acceptMarkdown : loadAcceptMd();
    let stampEnd = null, stampTimer = null;

    /* ----- inline tokenizer (operates in absolute source offsets) ----- */
    function findSingle(s, ch, from) {
      for (let j = from; j < s.length; j++)
        if (s[j] === ch && s[j + 1] !== ch && s[j - 1] !== ch && j > from) return j;
      return -1;
    }
    // DOCS-8 invisible styling: find the @{/s} that closes the @{s:…} starting just
    // before `from`, honoring nested style spans (depth). Returns the content-index of
    // the matching @{/s}, or -1 if unbalanced (then the opener falls through to text).
    function findStyleClose(s, from) {
      let depth = 0, i = from, n = s.length;
      while (i < n) {
        if (s[i] === "@" && s[i + 1] === "{") {
          if (s.startsWith("/s}", i + 2)) { if (depth === 0) return i; depth--; i += 5; continue; }
          if (s.startsWith("s:", i + 2)) { depth++; i += 2; continue; }
        }
        i++;
      }
      return -1;
    }
    function parseInline(content, base) {
      const out = []; let i = 0, ts = 0; const n = content.length;
      const pushText = end => { if (end > ts) out.push({ kind: "text", s: base + ts, text: content.slice(ts, end) }); };
      while (i < n) {
        const c = content[i];
        if (c === "@" && content[i + 1] === "{") {
          const cl = content.indexOf("}", i + 2);
          if (cl > i + 1) {
            const inner = content.slice(i + 2, cl), ci = inner.indexOf(":");
            if (ci > 0) {
              const ctype = inner.slice(0, ci), cval = inner.slice(ci + 1);
              if (ctype === "person" || ctype === "date") {
                pushText(i); out.push({ kind: "chip", ctype, cval, s: base + i, e: base + cl + 1 }); i = cl + 1; ts = i; continue;
              }
              if (ctype === "s") {   // DOCS-8 invisible-styling span: @{s:SPEC}…@{/s}
                const close = findStyleClose(content, cl + 1);
                if (close >= 0) {
                  pushText(i);
                  out.push({ kind: "style", spec: cval, s: base + i, e: base + close + 5,
                             openEnd: base + cl + 1, closeStart: base + close, inner: content.slice(cl + 1, close) });
                  i = close + 5; ts = i; continue;
                }
              }
            }
          }
        }
        if (c === "%" && content[i + 1] === "%") {
          const cl = content.indexOf("%%", i + 2);   // a %%…%% comment: hidden by render, kept in source
          if (cl > i + 1) { pushText(i); out.push({ kind: "comment", open: "%%", close: "%%", s: base + i, e: base + cl + 2, inner: content.slice(i + 2, cl) }); i = cl + 2; ts = i; continue; }
          // unclosed %% (mid-typing): fall through to plain text
        }
        if (c === "<" && content[i + 1] === "!" && content[i + 2] === "-" && content[i + 3] === "-") {
          const cl = content.indexOf("-->", i + 4);   // an <!--…--> HTML comment: same hidden-by-render treatment as %%
          if (cl >= i + 4) { pushText(i); out.push({ kind: "comment", open: "<!--", close: "-->", s: base + i, e: base + cl + 3, inner: content.slice(i + 4, cl) }); i = cl + 3; ts = i; continue; }
          // unclosed <!-- (mid-typing / multiline): fall through to plain text
        }
        if (c === "`") {
          const cl = content.indexOf("`", i + 1);
          if (cl > i) { pushText(i); out.push({ kind: "code", s: base + i, e: base + cl + 1, inner: content.slice(i + 1, cl) }); i = cl + 1; ts = i; continue; }
        }
        if ((c === "*" && content[i + 1] === "*") || (c === "_" && content[i + 1] === "_")) {
          const mk = content.slice(i, i + 2), cl = content.indexOf(mk, i + 2);
          if (cl > i + 1) { pushText(i); out.push({ kind: "strong", mark: mk, s: base + i, e: base + cl + 2, inner: content.slice(i + 2, cl) }); i = cl + 2; ts = i; continue; }
        }
        if (c === "~" && content[i + 1] === "~") {
          const cl = content.indexOf("~~", i + 2);
          if (cl > i + 1) { pushText(i); out.push({ kind: "del", mark: "~~", s: base + i, e: base + cl + 2, inner: content.slice(i + 2, cl) }); i = cl + 2; ts = i; continue; }
        }
        if ((c === "*" || c === "_") && content[i + 1] !== c) {
          const cl = findSingle(content, c, i + 1);
          if (cl > i) { pushText(i); out.push({ kind: "em", mark: c, s: base + i, e: base + cl + 1, inner: content.slice(i + 1, cl) }); i = cl + 1; ts = i; continue; }
        }
        if (c === "[") {
          const cb = content.indexOf("]", i + 1);
          if (cb > i && content[cb + 1] === "(") {
            const cp = content.indexOf(")", cb + 2);
            if (cp > cb) { pushText(i); out.push({ kind: "link", s: base + i, e: base + cp + 1, ltext: content.slice(i + 1, cb), url: content.slice(cb + 2, cp) }); i = cp + 1; ts = i; continue; }
          }
        }
        i++;
      }
      pushText(n);
      return out;
    }

    /* ----- block classify ----- */
    function classify(ln, s, e) {
      let m;
      if ((m = ln.match(/^(#{1,6})(\s+)(.*)$/))) return { type: "h", lvl: m[1].length, mlen: m[1].length + m[2].length, s, e, raw: ln };
      if ((m = ln.match(/^(\s*>\s?)(.*)$/)))      return { type: "bq", mlen: m[1].length, s, e, raw: ln };
      if ((m = ln.match(/^(\s*[-*+]\s+)(.*)$/)))  return { type: "li", mlen: m[1].length, s, e, raw: ln };
      if ((m = ln.match(/^(\s*\d+\.\s+)(.*)$/)))  return { type: "ol", mlen: m[1].length, s, e, raw: ln };
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(ln)) return { type: "hr", s, e, raw: ln };
      if (/^\s*%%.*%%\s*$/.test(ln))               return { type: "meta", s, e, raw: ln };
      if (/^\s*<!--.*-->\s*$/.test(ln))            return { type: "meta", s, e, raw: ln };
      if (ln.length === 0)                         return { type: "blank", s, e, raw: ln };
      return { type: "p", s, e, raw: ln };
    }

    // Which lines sit inside a CLEAN <!--…--> HTML-comment block (single- OR multi-
    // line). Those lines never render and never clean-export — but they stay in `text`,
    // so they round-trip to disk / the backend untouched.
    //   • Whole-line single comment (`^\s*<!--…-->\s*$`)  → hidden.
    //   • Block: a line that OPENS with `<!--` (no `-->` on it) … through a line that
    //     CLOSES with `-->` at its end  → every line in between hidden.
    // Deliberately conservative so a stray edit can't swallow real text: a mid-line
    // inline `text <!--…--> text` is left to parseInline's `tok.cm` (surrounding text
    // still shows); an open block whose close line has trailing text after `-->`, or
    // an UNCLOSED `<!--` (e.g. mid-typing), is left fully visible as plain text rather
    // than blanking content.
    function commentLines(lines) {
      const hidden = new Array(lines.length).fill(false);
      let open = -1;   // first line of a cleanly-opened, still-unclosed <!-- block, else -1
      for (let k = 0; k < lines.length; k++) {
        if (open < 0) {
          if (/^\s*<!--.*-->\s*$/.test(lines[k])) { hidden[k] = true; continue; }   // whole-line single
          if (/^\s*<!--/.test(lines[k]) && lines[k].indexOf("-->") < 0) open = k;    // clean block open
        } else if (/-->\s*$/.test(lines[k])) {                                        // clean block close
          for (let m = open; m <= k; m++) hidden[m] = true; open = -1;
        } else if (lines[k].indexOf("-->") >= 0) {                                    // text after --> ⇒ not clean
          open = -1;                                                                  // bail: leave the block visible
        }
      }
      return hidden;
    }

    /* ----- DOM building ----- */
    function leafSpan(str, s, cls) {
      const sp = document.createElement("span");
      sp.className = cls; sp.dataset.s = s; sp.dataset.len = str.length;
      sp.appendChild(document.createTextNode(str));
      leaves.push({ el: sp, s, len: str.length });
      return sp;
    }
    // a DOCS-8 style marker (@{s:…} / @{/s}): one atomic, contenteditable-false,
    // never-revealed leaf. Atomic ⇒ caret skips it and backspace removes it whole;
    // it is NOT pushed to `toks`, so unlike %% it never peeks open as raw syntax.
    function styleMarkerLeaf(str, s) {
      const sp = document.createElement("span");
      sp.className = "stymk"; sp.dataset.s = s; sp.dataset.len = str.length;
      sp.setAttribute("contenteditable", "false");
      sp.appendChild(document.createTextNode(str));
      leaves.push({ el: sp, s, len: str.length, atomic: true });
      return sp;
    }
    // a list marker source ("- " / "  1. ") carried as ONE atomic, contenteditable-false,
    // NEVER-rendered leaf — like styleMarkerLeaf. The visible bullet/number is drawn by CSS
    // ::before from div.dataset.marker, so the raw markdown never shows (Word/Docs feel) and
    // backspace at content-start removes the whole marker (de-lists), via atomicBefore.
    function listMarkerLeaf(str, s) {
      const sp = document.createElement("span");
      sp.className = "lmk"; sp.dataset.s = s; sp.dataset.len = str.length;
      sp.setAttribute("contenteditable", "false");
      sp.appendChild(document.createTextNode(str));
      leaves.push({ el: sp, s, len: str.length, atomic: true });
      return sp;
    }
    function appendInline(parent, content, base) {
      for (const t of parseInline(content, base)) {
        if (t.kind === "text") { parent.appendChild(leafSpan(t.text, t.s, "seg")); continue; }
        if (t.kind === "chip") {
          const el = document.createElement("span");
          el.className = "chip chip-" + t.ctype;
          if (t.ctype === "person") applyAccent(el, t.cval);
          el.setAttribute("contenteditable", "false");
          el.dataset.s = t.s; el.dataset.len = t.e - t.s; el.dataset.atomic = "1";
          el.textContent = t.ctype === "date" ? fmtDateLabel(t.cval) : t.cval;
          leaves.push({ el, s: t.s, len: t.e - t.s, atomic: true });
          parent.appendChild(el); continue;
        }
        if (t.kind === "style") {
          // styled run: invisible atomic markers wrap normally-editable, recursed content
          const tok = document.createElement("span"); tok.className = "tok sty";
          applyStyleSpec(tok, t.spec);
          tok.appendChild(styleMarkerLeaf("@{s:" + t.spec + "}", t.s));
          appendInline(tok, t.inner, t.openEnd);
          tok.appendChild(styleMarkerLeaf("@{/s}", t.closeStart));
          parent.appendChild(tok); continue;   // intentionally NOT added to `toks` (never reveals)
        }
        if (t.kind === "comment") {
          // three leaves (open + inner + close) keep the leaf-coverage invariant; CSS hides it.
          // markers vary: a %%…%% or an <!--…--> HTML comment — both collapse the same way.
          const open = t.open || "%%", close = t.close || "%%";
          const tok = document.createElement("span"); tok.className = "tok cm";
          toks.push({ el: tok, s: t.s, e: t.e });
          tok.appendChild(leafSpan(open, t.s, "mk"));
          tok.appendChild(leafSpan(t.inner, t.s + open.length, "seg"));
          tok.appendChild(leafSpan(close, t.e - close.length, "mk"));
          parent.appendChild(tok); continue;
        }
        if (t.kind === "code") {
          const tok = document.createElement("span"); tok.className = "tok code";
          toks.push({ el: tok, s: t.s, e: t.e });
          tok.appendChild(leafSpan("`", t.s, "mk"));
          tok.appendChild(leafSpan(t.inner, t.s + 1, "seg"));
          tok.appendChild(leafSpan("`", t.e - 1, "mk"));
          parent.appendChild(tok); continue;
        }
        if (t.kind === "link") {
          const tok = document.createElement("span"); tok.className = "tok a"; tok.dataset.href = t.url;
          toks.push({ el: tok, s: t.s, e: t.e });
          tok.appendChild(leafSpan("[", t.s, "mk"));
          tok.appendChild(leafSpan(t.ltext, t.s + 1, "ltext"));
          tok.appendChild(leafSpan("](", t.s + 1 + t.ltext.length, "mk"));
          tok.appendChild(leafSpan(t.url, t.s + 3 + t.ltext.length, "url"));
          tok.appendChild(leafSpan(")", t.e - 1, "mk"));
          parent.appendChild(tok); continue;
        }
        // strong / em / del — markers, then recurse into inner for nesting
        const cls = t.kind === "strong" ? "b" : t.kind === "del" ? "del" : "em";
        const mlen = t.mark.length;
        const tok = document.createElement("span"); tok.className = "tok " + cls;
        toks.push({ el: tok, s: t.s, e: t.e });
        tok.appendChild(leafSpan(t.mark, t.s, "mk"));
        appendInline(tok, t.inner, t.s + mlen);
        tok.appendChild(leafSpan(t.mark, t.e - mlen, "mk"));
        parent.appendChild(tok);
      }
    }
    /* ----- Word/Docs-style list markers: each list line's depth (from leading-space
       indent) and STATIC marker are computed here; numbers/letters auto-renumber by
       position (1,2,3 / a,b,c / i,ii,iii), bullets cycle • ◦ ▪ by depth. The raw "- "/
       "1. " source is hidden (listMarkerLeaf); CSS draws the marker from data-marker. */
    const LIST_INDENT = 2;                  // spaces per nesting level
    const BULLET_GLYPHS = ["•", "◦", "▪"];
    function toAlpha(n) { let s = ""; while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } return s || "a"; }
    function toRoman(n) {
      if (n <= 0) return "i";
      const map = [[1000,"m"],[900,"cm"],[500,"d"],[400,"cd"],[100,"c"],[90,"xc"],[50,"l"],[40,"xl"],[10,"x"],[9,"ix"],[5,"v"],[4,"iv"],[1,"i"]];
      let s = ""; for (const [v, sym] of map) while (n >= v) { s += sym; n -= v; } return s;
    }
    function listMarker(type, count, depth) {
      if (type === "ul") return BULLET_GLYPHS[depth % 3];
      const d = depth % 3, num = d === 1 ? toAlpha(count) : d === 2 ? toRoman(count) : String(count);
      return num + ".";
    }
    // → array indexed by line: { depth, marker } for each list line, else null. Ordered
    // counters reset on a shallower line, a type switch, or any non-list non-blank line.
    function computeListMarkers(lines, hidden) {
      const out = new Array(lines.length).fill(null), counts = [];
      for (let k = 0; k < lines.length; k++) {
        if (hidden[k]) continue;            // no-render comment block — leave counters as-is
        const ln = lines[k]; let mm, type = null, depth = 0;
        if ((mm = ln.match(/^( *)([-*+])\s+/)))      { type = "ul"; depth = Math.floor(mm[1].length / LIST_INDENT); }
        else if ((mm = ln.match(/^( *)(\d+)\.\s+/))) { type = "ol"; depth = Math.floor(mm[1].length / LIST_INDENT); }
        if (!type) { if (ln.trim() !== "") counts.length = 0; continue; }   // blanks keep the list alive
        counts.length = depth + 1;          // drop deeper counters (restart on re-descent)
        if (type === "ol") { counts[depth] = (counts[depth] || 0) + 1; out[k] = { depth, marker: listMarker("ol", counts[depth], depth) }; }
        else { counts[depth] = 0; out[k] = { depth, marker: listMarker("ul", 0, depth) }; }   // a bullet breaks the ordered run at its depth
      }
      return out;
    }
    function render() {
      suppress = true;
      clearStamp();   // a pending one-time mark "stamp" never survives a rebuild (undo/redo, setText, table sync)
      surface.textContent = "";
      leaves = []; blocks = []; toks = [];
      const lines = text.split("\n");
      const starts = []; { let o = 0; for (let k = 0; k < lines.length; k++) { starts.push(o); o += lines[k].length + 1; } }
      const hidden = commentLines(lines);
      const listInfo = computeListMarkers(lines, hidden);
      let i = 0;
      while (i < lines.length) {
        // A whole <!--…--> comment block: kept verbatim in `text`, but NOT rendered.
        // display:none takes it out of layout entirely — no caret, selection, or
        // highlight can ever enter it (unlike a zero-height line, which stays in flow).
        // One ATOMIC leaf spans the block so offset-mapping treats it as a single unit
        // the caret only ever sits beside, exactly like a table/chip island.
        if (hidden[i]) {
          let j = i; while (j < lines.length && hidden[j]) j++;
          const hs = starts[i], he = starts[j - 1] + lines[j - 1].length;
          const ph = document.createElement("div"); ph.className = "ln cmh";
          blocks.push({ el: ph, s: hs, e: he });
          leaves.push({ el: ph, s: hs, len: he - hs, atomic: true });
          surface.appendChild(ph);
          i = j; continue;
        }
        // a table run = optional "%%cols%%" line + header row + delimiter + body rows.
        // Look AHEAD so a preceding cols line is claimed INTO the table's source range.
        const colsMeta = isColsLine(lines[i]) && i + 2 < lines.length && isRow(lines[i + 1]) && isDelim(lines[i + 2]);
        const tableTop = isRow(lines[i]) && i + 1 < lines.length && isDelim(lines[i + 1]);
        if (colsMeta || tableTop) {
          const hdr = colsMeta ? i + 1 : i;
          let j = hdr + 2; while (j < lines.length && isRow(lines[j])) j++;
          const s = starts[i], e = starts[j - 1] + lines[j - 1].length;
          surface.appendChild(renderTable(lines.slice(i, j), s, e));
          i = j; continue;
        }
        const ln = lines[i], s = starts[i], b = classify(ln, s, s + ln.length);
        const div = document.createElement("div");
        div.className = "ln " + ({ h: "h h" + b.lvl, bq: "bq", li: "li", ol: "ol", hr: "hr", blank: "blank", p: "p", meta: "meta" }[b.type] || "p");
        blocks.push({ el: div, s: b.s, e: b.e });
        if (b.type === "h" || b.type === "bq") {
          div.appendChild(leafSpan(b.raw.slice(0, b.mlen), b.s, "blockmk"));
          appendInline(div, b.raw.slice(b.mlen), b.s + b.mlen);
        } else if (b.type === "li" || b.type === "ol") {
          const info = listInfo[i] || { depth: 0, marker: b.type === "ol" ? "1." : "•" };
          div.dataset.marker = info.marker; div.style.setProperty("--li-depth", info.depth);
          div.appendChild(listMarkerLeaf(b.raw.slice(0, b.mlen), b.s));   // hidden atomic source marker
          const liBody = b.raw.slice(b.mlen);
          if (liBody === "") {
            // EMPTY item: give it a real editable caret box AFTER the marker (mirror the blank
            // branch). Without this its only child is the display:none .lmk, so on refocus/reload
            // the native caret collapses to the line start — landing BEFORE the bullet ("text-").
            const sp = leafSpan("", b.s + b.mlen, "seg");
            sp.appendChild(document.createElement("br"));
            div.appendChild(sp);
          } else {
            appendInline(div, liBody, b.s + b.mlen);
          }
        } else if (b.type === "hr") {
          div.appendChild(leafSpan(b.raw, b.s, "seg"));
        } else if (b.type === "blank") {
          div.dataset.s = b.s; div.dataset.len = 0;
          leaves.push({ el: div, s: b.s, len: 0 });
          div.appendChild(document.createElement("br"));
        } else {
          appendInline(div, b.raw, b.s);
        }
        surface.appendChild(div);
        i++;
      }
      applyReveal();
      suppress = false;
      if (tocRefresh) tocRefresh();
      if (wcRefresh) wcRefresh();
      if (remoteCarets.length) positionRemoteCarets();   // additive: re-pin overlays after each rebuild
    }

    /* ----- tables: GFM detected in source, rendered house-style; cells are
       native-edited islands that reserialize the table back into the source ----- */
    function isRow(ln) { return /^\s*\|.*\|\s*$/.test(ln); }
    function isDelim(ln) { const t = ln.trim(); return /^[\s|:\-]+$/.test(t) && t.indexOf("-") >= 0 && t.indexOf("|") >= 0; }
    // column widths persist as a "%%cols:34,33,33%%" comment line directly above the table (percent of table width)
    function isColsLine(ln) { return /^\s*%%cols:[^%]*%%\s*$/.test(ln); }
    function colsFromCSV(csv) { if (!csv) return null; const a = String(csv).split(",").map(x => parseFloat(x)).filter(n => !isNaN(n) && n > 0); return a.length ? a : null; }
    function parseCols(ln) { const m = /^\s*%%cols:([^%]*)%%\s*$/.exec(ln); return m ? colsFromCSV(m[1]) : null; }
    // optional table width rides the SAME %%cols%% line as "w:NN" (percent of the surface, 20–100)
    function parseTW(ln) { const m = /\bw:(\d+(?:\.\d+)?)/.exec(ln || ""); if (!m) return null; const v = parseFloat(m[1]); return (v >= 20 && v <= 100) ? v : null; }
    function normalizeCols(ws) {
      const MIN = 5, sum = ws.reduce((a, b) => a + b, 0) || 1;
      const r = ws.map(w => Math.max(MIN, Math.round(w / sum * 100)));
      r[r.length - 1] += 100 - r.reduce((a, b) => a + b, 0);
      if (r[r.length - 1] < MIN) r[r.length - 1] = MIN;
      return r;
    }
    // strip only the single padding space GFM puts around cell content, so spaces the user types survive a re-render
    function splitCells(row) { let t = row.trim(); if (t[0] === "|") t = t.slice(1); if (t[t.length - 1] === "|") t = t.slice(0, -1); return t.split("|").map(c => c.replace(/^ /, "").replace(/ $/, "")); }
    function cellText(cell) { return (cell.textContent || "").replace(/​/g, "").replace(/[\r\n]+/g, " ").replace(/\|/g, "/"); }
    /* ---- rich table cells (Feature 1): a cell's content is stored as markdown in the GFM
       source cell — <br> for hard line breaks, ** / * / ` inline, "• " prefix for a bulleted
       line; "|" -> "/" (can't appear in a GFM cell). It renders STATICALLY formatted (real
       <strong>, line breaks, no visible markers) and re-serializes on every edit. ---- */
    function wrapCellInline(t, b, i, c) {   // wrap a same-style run back into markdown markers
      if (c) return "`" + t + "`";
      const pre = (/^\s*/.exec(t) || [""])[0], post = (/\s*$/.exec(t) || [""])[0];
      const mid = t.slice(pre.length, t.length - post.length);
      if (!mid) return t;                                   // whitespace-only: no markers
      let m = mid;
      if (b && i) m = "**_" + m + "_**"; else if (b) m = "**" + m + "**"; else if (i) m = "*" + m + "*";
      return pre + m + post;
    }
    function cellInlineToHtml(seg) {   // minimal ** / * / _ / ` parser; everything else literal+escaped (no links/chips in cells)
      let out = "", i = 0; const n = seg.length;
      while (i < n) {
        const c = seg[i];
        if (c === "`") { const cl = seg.indexOf("`", i + 1); if (cl > i) { out += "<code>" + esc(seg.slice(i + 1, cl)) + "</code>"; i = cl + 1; continue; } }
        if ((c === "*" && seg[i + 1] === "*") || (c === "_" && seg[i + 1] === "_")) { const mk = seg.slice(i, i + 2), cl = seg.indexOf(mk, i + 2); if (cl > i + 1) { out += "<strong>" + cellInlineToHtml(seg.slice(i + 2, cl)) + "</strong>"; i = cl + 2; continue; } }
        if ((c === "*" || c === "_") && seg[i + 1] !== c) { const cl = seg.indexOf(c, i + 1); if (cl > i + 1) { out += "<em>" + cellInlineToHtml(seg.slice(i + 1, cl)) + "</em>"; i = cl + 1; continue; } }
        out += esc(c); i++;
      }
      return out;
    }
    function cellMdToHtml(md) { return String(md == null ? "" : md).split("<br>").map(cellInlineToHtml).join("<br>"); }
    function cellToMd(cell) {   // walk the rich-contenteditable cell DOM back into markdown
      const runs = [];
      (function walk(node, b, i, c) {
        for (const ch of node.childNodes) {
          if (ch.nodeType === 3) { const t = ch.nodeValue.replace(/​/g, ""); if (t) runs.push({ t: t.replace(/\|/g, "/"), b, i, c }); }
          else if (ch.nodeType === 1) {
            const tag = ch.tagName.toLowerCase();
            if (tag === "br") { runs.push({ br: true }); continue; }
            const st = ch.style || {};
            const nb = b || tag === "b" || tag === "strong" || /^(bold|[6-9]00)$/.test(st.fontWeight || "");
            const ni = i || tag === "i" || tag === "em" || st.fontStyle === "italic";
            const nc = c || tag === "code" || tag === "tt";
            if ((tag === "div" || tag === "p") && runs.length && !runs[runs.length - 1].br) runs.push({ br: true });   // block boundary → line break
            walk(ch, nb, ni, nc);
          }
        }
      })(cell, false, false, false);
      let md = "";
      for (let k = 0; k < runs.length; k++) {
        const r = runs[k];
        if (r.br) { md += "<br>"; continue; }
        let txt = r.t;
        while (k + 1 < runs.length && !runs[k + 1].br && runs[k + 1].b === r.b && runs[k + 1].i === r.i && runs[k + 1].c === r.c) txt += runs[++k].t;   // coalesce same-style runs
        md += wrapCellInline(txt, r.b, r.i, r.c);
      }
      return md;
    }
    function cellLen(cell) { let n = 0; const w = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, { acceptNode: x => (x.nodeType === 3 || x.nodeName === "BR") ? 1 : 3 }); let k; while ((k = w.nextNode())) n += k.nodeName === "BR" ? 1 : k.nodeValue.length; return n; }
    function cellLineStartNode(cell) {   // first top-level child of the caret's visual line (after the previous <br>)
      const sel = document.getSelection(); if (!sel.rangeCount || !cell.contains(sel.focusNode)) return null;
      let fc = sel.focusNode; while (fc && fc.parentNode !== cell) fc = fc.parentNode;
      const kids = [...cell.childNodes]; let fi = kids.indexOf(fc); if (fi < 0) fi = kids.length - 1;
      let start = fi; while (start > 0 && kids[start - 1].nodeName !== "BR") start--;
      return kids[start] || null;
    }
    function cellLineIsBullet(cell) { const fn = cellLineStartNode(cell); return /^•\s/.test((fn && fn.textContent) || ""); }
    function cellToggleBullet(cell) {   // Cmd/Ctrl+Shift+8: toggle a "• " prefix on the caret's line
      const fn = cellLineStartNode(cell); if (fn === null && !document.getSelection().rangeCount) return;
      const ft = fn && fn.nodeType === 3 ? fn : (fn && fn.firstChild && fn.firstChild.nodeType === 3 ? fn.firstChild : null);
      if (ft && /^•\s/.test(ft.nodeValue)) ft.nodeValue = ft.nodeValue.replace(/^•\s/, "");
      else cell.insertBefore(document.createTextNode("• "), fn || null);
      syncTable(cell);
    }
    function rowGFM(cells, cols) { let o = "|"; for (let c = 0; c < cols; c++) o += " " + (cells[c] != null ? String(cells[c]) : "") + " |"; return o; }
    function emitTable(head, body, widths, tw) {
      const cols = head.length;
      const out = [];
      // column widths AND optional table width (w:NN) ride one %%cols%% meta line above the table
      const colsCsv = (widths && widths.length) ? widths.slice(0, cols).join(",") : "";
      const twPart = (tw != null && tw < 100) ? (colsCsv ? " " : "") + "w:" + tw : "";
      if (colsCsv || twPart) out.push("%%cols:" + colsCsv + twPart + "%%");   // re-emitted on EVERY edit so it survives
      out.push(rowGFM(head, cols), "|" + " --- |".repeat(cols));
      body.forEach(r => out.push(rowGFM(r, cols)));
      return out.join("\n");
    }
    function cellOf(node) { if (!node) return null; const el = node.nodeType === 3 ? node.parentElement : node; return el && el.closest ? el.closest(".mcell") : null; }
    function selInCell() { const s = document.getSelection(); return !!(s && s.rangeCount && cellOf(s.anchorNode)); }

    function mkCell(tag, content, r, c) {
      const cell = document.createElement(tag); cell.className = "mcell";
      cell.setAttribute("contenteditable", "true");   // rich (was plaintext-only): allows <br>, bold, italic
      cell.dataset.r = r; cell.dataset.c = c; cell.innerHTML = cellMdToHtml(content);
      cell.addEventListener("input", e => { e.stopPropagation(); if (!composing) syncTable(cell); });
      cell.addEventListener("keydown", onCellKey);
      cell.addEventListener("paste", e => { e.stopPropagation(); e.preventDefault(); let d = ((e.clipboardData || window.clipboardData).getData("text/plain") || "").replace(/\|/g, "/"); d = esc(d).replace(/\r?\n/g, "<br>"); document.execCommand("insertHTML", false, d); });
      cell.addEventListener("copy", e => e.stopPropagation());
      cell.addEventListener("cut", e => e.stopPropagation());
      return cell;
    }
    function renderTable(rawLines, s, e) {
      let widths = null, tw = null, off = 0;
      if (isColsLine(rawLines[0])) { widths = parseCols(rawLines[0]); tw = parseTW(rawLines[0]); off = 1; }   // claim a leading %%cols%% line
      const head = splitCells(rawLines[off]);
      const body = rawLines.slice(off + 2).map(splitCells);
      const cols = Math.max(head.length, body.reduce((m, r) => Math.max(m, r.length), 0), 1);
      const wrap = document.createElement("div"); wrap.className = "mtable-wrap"; wrap.setAttribute("contenteditable", "false");
      wrap.dataset.s = s; wrap.dataset.e = e;
      if (widths) wrap.dataset.cols = widths.join(",");
      if (tw != null) wrap.dataset.tw = tw;
      const table = document.createElement("table"); table.className = "mtable";
      if (tw != null) table.style.width = tw + "%";   // narrower-than-full table (default CSS is width:100%)
      if (widths && widths.length) {
        const cg = document.createElement("colgroup");
        for (let c = 0; c < cols; c++) { const col = document.createElement("col"); if (widths[c] != null) col.style.width = widths[c] + "%"; cg.appendChild(col); }
        table.appendChild(cg); table.style.tableLayout = "fixed";
      }
      const thead = document.createElement("thead"), htr = document.createElement("tr");
      for (let c = 0; c < cols; c++) htr.appendChild(mkCell("th", head[c] || "", 0, c));
      thead.appendChild(htr); table.appendChild(thead);
      const tbody = document.createElement("tbody");
      body.forEach((r, ri) => { const tr = document.createElement("tr"); for (let c = 0; c < cols; c++) tr.appendChild(mkCell("td", r[c] || "", ri + 1, c)); tbody.appendChild(tr); });
      table.appendChild(tbody); wrap.appendChild(table); wrap.appendChild(tableTools(wrap));
      wrap.addEventListener("pointerenter", () => layoutGrips(wrap));
      requestAnimationFrame(() => layoutGrips(wrap));
      leaves.push({ el: wrap, s, len: e - s, atomic: true });
      blocks.push({ el: wrap, s, e });
      return wrap;
    }
    /* ----- column resize: grips overlay the column boundaries; a drag is ephemeral DOM,
       committed to the %%cols%% line through the controlled render path on pointerup ----- */
    function layoutGrips(wrap) {
      if (!wrap.isConnected) return;
      const table = wrap.querySelector("table.mtable"); if (!table) return;
      let layer = wrap.querySelector(".mcol-grips");
      if (!layer) { layer = document.createElement("div"); layer.className = "mcol-grips"; layer.setAttribute("contenteditable", "false"); wrap.appendChild(layer); }
      const ths = [...table.querySelectorAll("thead th")];
      const wr = wrap.getBoundingClientRect(), tr = table.getBoundingClientRect();
      layer.innerHTML = "";
      for (let c = 0; c < ths.length - 1; c++) {
        const r = ths[c].getBoundingClientRect();
        const grip = document.createElement("div"); grip.className = "mcol-grip";
        grip.style.left = (r.right - wr.left) + "px"; grip.style.top = (tr.top - wr.top) + "px"; grip.style.height = tr.height + "px";
        attachGrip(grip, wrap, table, c);
        layer.appendChild(grip);
      }
      // right-edge handle: drag to set the whole table's width (< full width)
      const wg = document.createElement("div"); wg.className = "mwidth-grip";
      wg.style.left = (tr.right - wr.left) + "px"; wg.style.top = (tr.top - wr.top) + "px"; wg.style.height = tr.height + "px";
      attachWidthGrip(wg, wrap, table);
      layer.appendChild(wg);
    }
    function repositionGrips(wrap) {
      const layer = wrap.querySelector(".mcol-grips"), table = wrap.querySelector("table.mtable");
      if (!layer || !table) return;
      const ths = [...table.querySelectorAll("thead th")], wr = wrap.getBoundingClientRect();
      layer.querySelectorAll(".mcol-grip").forEach((grip, c) => { if (ths[c]) grip.style.left = (ths[c].getBoundingClientRect().right - wr.left) + "px"; });
      const wg = layer.querySelector(".mwidth-grip");
      if (wg) wg.style.left = (table.getBoundingClientRect().right - wr.left) + "px";
    }
    function attachGrip(grip, wrap, table, c) {
      grip.addEventListener("pointerdown", e => {
        e.preventDefault(); e.stopPropagation();
        const ths = [...table.querySelectorAll("thead th")], tableW = table.getBoundingClientRect().width || 1;
        const cur = ths.map(th => th.getBoundingClientRect().width / tableW * 100);
        const startX = e.clientX, lStart = cur[c], rStart = cur[c + 1], MIN = 5;
        grip.classList.add("dragging");
        // window-level listeners (no pointer-capture dependency) make the drag robust
        const onMove = ev => {
          let d = (ev.clientX - startX) / tableW * 100, nl = lStart + d, nr = rStart - d;
          if (nl < MIN) { nr -= (MIN - nl); nl = MIN; }
          if (nr < MIN) { nl -= (MIN - nr); nr = MIN; }
          cur[c] = nl; cur[c + 1] = nr; applyColWidths(table, cur); repositionGrips(wrap);
        };
        const onUp = () => {
          grip.classList.remove("dragging");
          window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp);
          commitCols(wrap, normalizeCols(cur));
        };
        window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
      });
    }
    /* ----- table-width resize: drag the right-edge handle; committed to "w:NN" on the
       %%cols%% line on pointerup. Width is a percent of the surface; ≥~100 clears it. ----- */
    function attachWidthGrip(grip, wrap, table) {
      grip.addEventListener("pointerdown", e => {
        e.preventDefault(); e.stopPropagation();
        const wrapW = wrap.getBoundingClientRect().width || 1, left = table.getBoundingClientRect().left;
        grip.classList.add("dragging");
        let pct = 100;
        const onMove = ev => { pct = Math.max(20, Math.min(100, (ev.clientX - left) / wrapW * 100)); table.style.width = pct + "%"; repositionGrips(wrap); };
        const onUp = () => {
          grip.classList.remove("dragging");
          window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp);
          commitWidth(wrap, pct >= 99.5 ? null : Math.round(pct));
        };
        window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
      });
    }
    function applyColWidths(table, pcts) {
      let cg = table.querySelector("colgroup");
      if (!cg) { cg = document.createElement("colgroup"); for (let i = 0; i < pcts.length; i++) cg.appendChild(document.createElement("col")); table.insertBefore(cg, table.firstChild); }
      const cols = [...cg.children];
      pcts.forEach((p, i) => { if (cols[i]) cols[i].style.width = p + "%"; });
      table.style.tableLayout = "fixed";
    }
    function commitCols(wrap, widths) {
      const s = +wrap.dataset.s, e = +wrap.dataset.e, m = tableMatrix(wrap);
      snapshot("cols");
      text = text.slice(0, s) + emitTable(m.head, m.body, widths, tableMeta(wrap).tw) + text.slice(e);
      render(); onInput();
    }
    function commitWidth(wrap, tw) {   // persist the whole-table width drag into the %%cols%% meta
      const s = +wrap.dataset.s, e = +wrap.dataset.e, m = tableMatrix(wrap);
      snapshot("twidth");
      text = text.slice(0, s) + emitTable(m.head, m.body, tableMeta(wrap).widths, tw) + text.slice(e);
      render(); onInput();
    }
    function tableMatrix(wrap) {
      return { head: [...wrap.querySelectorAll("thead th")].map(cellToMd), body: [...wrap.querySelectorAll("tbody tr")].map(tr => [...tr.children].map(cellToMd)) };
    }
    function tableMeta(wrap) { return { widths: colsFromCSV(wrap.dataset.cols), tw: (wrap.dataset.tw != null && wrap.dataset.tw !== "") ? +wrap.dataset.tw : null }; }
    // offset = text chars + each <br> counted as 1 (the rendered-cell space; markers aren't shown)
    function caretInCell(cell) {
      const sel = document.getSelection(); if (!sel || !sel.rangeCount) return 0;
      const node = sel.focusNode; if (!cell.contains(node)) return cellLen(cell);
      let total = 0; const w = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, { acceptNode: x => (x.nodeType === 3 || x.nodeName === "BR") ? 1 : 3 }); let n;
      while ((n = w.nextNode())) {
        if (n === node) return total + (node.nodeType === 3 ? sel.focusOffset : 0);
        total += n.nodeName === "BR" ? 1 : n.nodeValue.length;
      }
      return total;
    }
    function syncTable(cell) {
      const wrap = cell.closest(".mtable-wrap"); if (!wrap) return;
      const cap = { tblS: +wrap.dataset.s, r: +cell.dataset.r, c: +cell.dataset.c, off: caretInCell(cell) };
      const s = +wrap.dataset.s, e = +wrap.dataset.e, m = tableMatrix(wrap);
      const meta = tableMeta(wrap);   // keep persisted column + table widths through a cell edit
      snapshot("cell");
      text = text.slice(0, s) + emitTable(m.head, m.body, meta.widths, meta.tw) + text.slice(e);
      render(); restoreCell(cap); onInput();
    }
    function restoreCell(cap) {
      const wrap = surface.querySelector('.mtable-wrap[data-s="' + cap.tblS + '"]'); if (!wrap) return;
      const cell = wrap.querySelector('.mcell[data-r="' + cap.r + '"][data-c="' + cap.c + '"]'); if (!cell) return;
      cell.focus({ preventScroll: true });
      const r = document.createRange();
      let rem = cap.off, placed = false, last = null;
      const w = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, { acceptNode: x => (x.nodeType === 3 || x.nodeName === "BR") ? 1 : 3 });
      let n;
      while ((n = w.nextNode())) {
        if (n.nodeType === 3) { const len = n.nodeValue.length; if (rem <= len) { r.setStart(n, rem); placed = true; break; } rem -= len; last = n; }
        else { if (rem === 0) { r.setStartBefore(n); placed = true; break; } rem -= 1; last = n; }   // <br>
      }
      if (!placed) { if (last && last.nodeType === 3) r.setStart(last, last.nodeValue.length); else r.setStart(cell, cell.childNodes.length); }
      r.collapse(true);
      const sel = document.getSelection(); suppress = true; sel.removeAllRanges(); sel.addRange(r); suppress = false;
    }
    function allCells(wrap) { return [...wrap.querySelectorAll(".mcell")]; }
    function focusCell(cell) { if (!cell) return; cell.focus({ preventScroll: true }); const r = document.createRange(); r.selectNodeContents(cell); r.collapse(false); const s = document.getSelection(); suppress = true; s.removeAllRanges(); s.addRange(r); suppress = false; }
    function atCellStart(cell) { const s = document.getSelection(); return s && s.isCollapsed && caretInCell(cell) === 0; }
    function atCellEnd(cell) { const s = document.getSelection(); return s && s.isCollapsed && caretInCell(cell) === cellLen(cell); }
    function tableIsEmpty(wrap) { return allCells(wrap).every(c => (c.textContent || "").trim() === ""); }
    function moveCell(cell, dir, addRowIfEnd) {
      const wrap = cell.closest(".mtable-wrap"), cells = allCells(wrap), idx = cells.indexOf(cell) + dir;
      if (idx >= cells.length) { addRowIfEnd ? addRow(wrap, true) : exitTable(wrap, 1); return; }
      if (idx < 0) { exitTable(wrap, -1); return; }
      focusCell(cells[idx]);
    }
    function enterCell(cell) {
      const wrap = cell.closest(".mtable-wrap"), r = +cell.dataset.r, c = +cell.dataset.c;
      let below = wrap.querySelector('.mcell[data-r="' + (r + 1) + '"][data-c="' + c + '"]');
      if (below) { focusCell(below); return; }
      addRow(wrap, false);
      below = surface.querySelector('.mtable-wrap[data-s="' + wrap.dataset.s + '"] .mcell[data-r="' + (r + 1) + '"][data-c="' + c + '"]');
      focusCell(below);
    }
    function onCellKey(e) {
      const cell = e.currentTarget, mod = e.metaKey || e.ctrlKey;
      if (e.key === "Tab") { e.preventDefault(); e.stopPropagation(); moveCell(cell, e.shiftKey ? -1 : 1, !e.shiftKey); return; }
      if (e.key === "Enter") {   // Word/Docs: Enter = line break INSIDE the cell; continue a bullet line
        e.preventDefault(); e.stopPropagation();
        const bullet = cellLineIsBullet(cell);
        document.execCommand("insertLineBreak");
        if (bullet) document.execCommand("insertText", false, "• ");
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); exitTable(cell.closest(".mtable-wrap"), 1); return; }
      if (mod && e.shiftKey && (e.key === "8" || e.key === "*" || e.code === "Digit8")) { e.preventDefault(); e.stopPropagation(); cellToggleBullet(cell); return; }
      if (mod && /^[bB]$/.test(e.key)) { e.preventDefault(); e.stopPropagation(); document.execCommand("bold"); return; }
      if (mod && /^[iI]$/.test(e.key)) { e.preventDefault(); e.stopPropagation(); document.execCommand("italic"); return; }
      if (mod && /^[uU]$/.test(e.key)) { e.preventDefault(); e.stopPropagation(); return; }   // underline isn't representable in md — swallow
      if (e.key === "ArrowRight" && atCellEnd(cell)) { e.preventDefault(); e.stopPropagation(); moveCell(cell, 1, false); return; }
      if (e.key === "ArrowLeft" && atCellStart(cell)) { e.preventDefault(); e.stopPropagation(); moveCell(cell, -1, false); return; }
      if (e.key === "Backspace" && cellLen(cell) === 0) {
        e.preventDefault(); e.stopPropagation();
        const wrap = cell.closest(".mtable-wrap");
        tableIsEmpty(wrap) ? deleteTable(wrap) : moveCell(cell, -1, false);
      }
    }
    function replaceTable(wrap, head, body, widths) {
      const s = +wrap.dataset.s, e = +wrap.dataset.e; snapshot("table");
      if (widths === undefined) widths = colsFromCSV(wrap.dataset.cols);
      text = text.slice(0, s) + emitTable(head, body, widths, tableMeta(wrap).tw) + text.slice(e); render(); onInput();
    }
    function addRow(wrap, focusFirst) {
      const m = tableMatrix(wrap), s = +wrap.dataset.s; m.body.push(new Array(m.head.length).fill(""));
      replaceTable(wrap, m.head, m.body);
      if (focusFirst) { const w = surface.querySelector('.mtable-wrap[data-s="' + s + '"]'); focusCell(w && w.querySelector("tbody tr:last-child .mcell")); }
    }
    function addCol(wrap) {
      const m = tableMatrix(wrap), s = +wrap.dataset.s; m.head.push(""); m.body.forEach(r => r.push(""));
      let widths = colsFromCSV(wrap.dataset.cols);
      if (widths) widths = normalizeCols(widths.concat([100 / (widths.length + 1)]));   // grow + renormalize to 100
      replaceTable(wrap, m.head, m.body, widths);
      const w = surface.querySelector('.mtable-wrap[data-s="' + s + '"]'); focusCell(w && w.querySelector("thead th:last-child"));
    }
    function exitTable(wrap, dir) {
      const s = +wrap.dataset.s, e = +wrap.dataset.e;
      if (dir > 0) { if (e >= text.length) { snapshot("table"); text = text.slice(0, e) + "\n"; render(); onInput(); } setCaret(Math.min(e + 1, text.length)); }
      else setCaret(Math.max(0, s - 1));
      surface.focus();
    }
    function deleteTable(wrap) {
      let s = +wrap.dataset.s, e = +wrap.dataset.e; snapshot("table");
      if (text[e] === "\n") e++; else if (s > 0 && text[s - 1] === "\n") s--;
      text = text.slice(0, s) + text.slice(e); render(); setCaret(Math.min(s, text.length)); surface.focus(); onInput();
    }
    function tableTools(wrap) {
      const tools = document.createElement("div"); tools.className = "mtable-tools"; tools.setAttribute("contenteditable", "false");
      const add = (label, svg, cls, fn) => { const b = document.createElement("button"); b.type = "button"; b.className = "mtt" + (cls ? " " + cls : ""); b.innerHTML = svg + (label ? "<span>" + label + "</span>" : ""); b.addEventListener("mousedown", ev => { ev.preventDefault(); fn(); }); tools.appendChild(b); };
      add("Row", '<svg viewBox="0 0 24 24"><path d="M4 8h16M4 13h16M4 18h16"/><path d="M20 4v4M22 6h-4"/></svg>', "", () => addRow(wrap, true));
      add("Col", '<svg viewBox="0 0 24 24"><path d="M8 4v16M13 4v16M18 4v16"/><path d="M4 6h4M6 4v4"/></svg>', "", () => addCol(wrap));
      add("", '<svg viewBox="0 0 24 24"><path d="M4.5 6.5h15M9.5 6.2V5h5v1.2M6.8 6.5l.8 13h8.8l.8-13"/></svg>', "danger", () => deleteTable(wrap));
      return tools;
    }
    function applyReveal() {
      const act = blocks.map(b => selA <= b.e && selB >= b.s);
      for (let i = 0; i < blocks.length; i++) {
        const el = blocks[i].el;
        let on = act[i];
        // a collapsed %%…%% meta line peeks open when an adjacent line is active, so it stays
        // reachable by click/arrow even though it is otherwise zero-height
        if (!on && el.classList && el.classList.contains("meta")) on = !!(act[i - 1] || act[i + 1]);
        el.classList.toggle("active", on);
      }
      for (const t of toks) {
        let on;
        if (isEmphTok(t.el)) {
          // demoted to easter egg: emphasis marks never reveal on caret entry. When acceptMd is on,
          // only the one-time "stamp" flash shows them; when off, raw marks stay shown (classic md).
          on = acceptMd ? (stampEnd != null && t.e === stampEnd) : true;
        } else {
          on = selA <= t.e && selB >= t.s;   // links / comments keep caret-reveal
        }
        t.el.classList.toggle("on", on);
      }
    }
    /* ----- markdown demotion: per-user accept-markdown + the one-time "stamp" flash ----- */
    function isEmphTok(el) {
      const c = el.classList;
      return c.contains("b") || c.contains("em") || c.contains("del") || c.contains("code");
    }
    function loadAcceptMd() { try { const v = localStorage.getItem("mde-accept-md"); return v == null ? true : v === "1"; } catch (_) { return true; } }
    function getAcceptMarkdown() { return acceptMd; }
    function setAcceptMarkdown(v) {
      acceptMd = !!v;
      try { localStorage.setItem("mde-accept-md", acceptMd ? "1" : "0"); } catch (_) {}
      clearStamp();
      // re-resolve the caret when focused, so toggling to "hidden" can't strand it inside a now-invisible mark
      if (document.activeElement === surface) setCaret(selA, selB); else applyReveal();
    }
    function clearStamp() { if (stampTimer) { clearTimeout(stampTimer); stampTimer = null; } stampEnd = null; }
    // After a render, if the just-typed char completed a NEW emphasis token ending at the caret,
    // reveal that token's marks briefly (the "first stamp"), then auto-hide. Only genuine
    // single-char typing reaches here — the toolbar/palette wrap path does not.
    function maybeStamp(car) {
      let hit = null;
      for (const t of toks) if (t.e === car && isEmphTok(t.el)) { hit = t; break; }
      if (!hit) return;
      stampEnd = car;
      if (stampTimer) clearTimeout(stampTimer);
      stampTimer = setTimeout(() => { stampTimer = null; stampEnd = null; applyReveal(); }, 1100);
    }

    /* ----- caret <-> source offset ----- */
    function leafOf(node) {
      let el = node.nodeType === 3 ? node.parentElement : node;
      while (el && el !== surface && !(el.dataset && el.dataset.s != null)) el = el.parentElement;
      return (el && el.dataset && el.dataset.s != null) ? el : null;
    }
    function firstLeafStart(node) {
      if (node.nodeType === 1 && node.dataset && node.dataset.s != null) return +node.dataset.s;
      if (node.nodeType === 1 && node.querySelector) { const el = node.querySelector("[data-s]"); if (el) return +el.dataset.s; }
      if (node.nodeType === 3) { const lf = leafOf(node); if (lf) return +lf.dataset.s; }
      return null;
    }
    function lastLeafEnd(node) {
      let el = null;
      if (node.nodeType === 1 && node.dataset && node.dataset.s != null) el = node;
      else if (node.nodeType === 1 && node.querySelectorAll) { const all = node.querySelectorAll("[data-s]"); el = all[all.length - 1] || null; }
      else if (node.nodeType === 3) el = leafOf(node);
      return el ? +el.dataset.s + (+el.dataset.len) : null;
    }
    // a caret may never rest BEFORE a list marker (the "- "/"1. " source is a hidden atomic
    // leaf): snap a line-start position to just AFTER the marker. Stops a click in the empty
    // space of an empty bullet — which resolves to the line start — landing before the bullet.
    function afterMarker(pos) { const lf = atomicAfter(pos); return (lf && lf.el.classList && lf.el.classList.contains("lmk")) ? lf.s + lf.len : pos; }
    function domToOffset(node, offset) {
      if (node === surface) {
        const ch = surface.childNodes[Math.min(offset, surface.childNodes.length - 1)];
        const blk = blocks.find(b => b.el === ch);
        return blk ? afterMarker(blk.s) : text.length;
      }
      if (node.nodeType === 3) {
        const leaf = leafOf(node);
        if (leaf) return +leaf.dataset.s + Math.min(offset, +leaf.dataset.len);
      } else {
        const kids = node.childNodes;
        if (offset < kids.length) { const o = firstLeafStart(kids[offset]); if (o != null) return o; }
        if (offset > 0 && offset - 1 < kids.length) { const o = lastLeafEnd(kids[offset - 1]); if (o != null) return o; }
        if (node.dataset && node.dataset.s != null) return +node.dataset.s + (offset > 0 ? +node.dataset.len : 0);
      }
      const leaf = leafOf(node);
      if (leaf) { const base = +leaf.dataset.s, len = +leaf.dataset.len; return node.nodeType === 3 ? base + Math.min(offset, len) : base + (offset > 0 ? len : 0); }
      const blk = blocks.find(b => b.el === node || b.el.contains(node));
      if (blk) return offset > 0 ? blk.e : afterMarker(blk.s);
      return selA;
    }
    function readSel() {
      const s = document.getSelection();
      if (!s || s.rangeCount === 0 || !surface.contains(s.anchorNode)) return null;
      let a = domToOffset(s.anchorNode, s.anchorOffset);
      let b = domToOffset(s.focusNode, s.focusOffset);
      return a <= b ? [a, b] : [b, a];
    }
    function isVisible(el) { return !!(el && (el.offsetParent || el === surface)); }
    function offsetToDom(off) {
      off = Math.max(0, Math.min(off, text.length));
      let best = null;
      for (const lf of leaves) {
        if (off >= lf.s && off <= lf.s + lf.len) {
          if (!best) best = lf;
          if (isVisible(lf.el)) { best = lf; if (off > lf.s && off < lf.s + lf.len) break; }
        }
      }
      if (!best) best = leaves[leaves.length - 1];
      if (!best) return { node: surface, offset: 0 };
      if (best.atomic) {
        const parent = best.el.parentNode || surface; const kids = parent.childNodes;
        let idx = 0; while (idx < kids.length && kids[idx] !== best.el) idx++;
        return { node: parent, offset: off <= best.s ? idx : idx + 1 };
      }
      // demoted emphasis marks are permanently hidden (acceptMd) — never strand the caret inside a
      // display:none mark span; place it just beside the mark (round-trips via first/lastLeafEnd).
      if (acceptMd && best.el.classList && best.el.classList.contains("mk") && best.el.parentNode && isEmphTok(best.el.parentNode)) {
        const parent = best.el.parentNode; const kids = parent.childNodes;
        let idx = 0; while (idx < kids.length && kids[idx] !== best.el) idx++;
        return { node: parent, offset: off <= best.s ? idx : idx + 1 };
      }
      if (best.len === 0) return { node: best.el, offset: 0 };
      return { node: best.el.firstChild, offset: Math.max(0, Math.min(off - best.s, best.len)) };
    }
    function setCaret(a, b) {
      selA = a; selB = (b == null ? a : b);
      const p = offsetToDom(selA), q = offsetToDom(selB);
      const r = document.createRange();
      r.setStart(p.node, p.offset); r.setEnd(q.node, q.offset);
      const s = document.getSelection();
      suppress = true; s.removeAllRanges(); s.addRange(r); suppress = false;
      applyReveal();
      notifyCaret();   // additive: publish the local caret to any awareness listener (no-op when none)
    }

    /* ----- model mutation + history ----- */
    function snapshot(type) {
      const t = Date.now();
      if (!(type === "type" && lastType === "type" && t - lastAt < 700)) {
        undo.push({ text, selA, selB }); if (undo.length > 300) undo.shift(); redo.length = 0;
      }
      lastType = type; lastAt = t;
    }
    function edit(a, b, ins, caret, type) {
      snapshot(type);
      text = text.slice(0, a) + ins + text.slice(b);
      render();   // clears any prior stamp; maybeStamp (below) arms a fresh one AFTER the rebuild
      const car = caret == null ? a + ins.length : caret;
      // one-time mark flash when a genuine keystroke completes a new emphasis token
      if (acceptMd && type === "type" && ins.length === 1 && (ins === "*" || ins === "_" || ins === "~" || ins === "`")) maybeStamp(car);
      setCaret(car);
      onInput();
      syncMenu();
    }
    function restore(stack, other) {
      if (!stack.length) return;
      other.push({ text, selA, selB });
      const st = stack.pop();
      text = st.text; render(); setCaret(st.selA, st.selB); lastType = null; onInput();
      closeMenu();
    }
    // Undo/redo route through these so a collab binding can swap in a CRDT-aware history
    // (Y.UndoManager, local-edits-only) without the editor knowing. extUndo/extRedo null ⇒
    // the built-in stacks run, identical to before. Used by keydown, beforeinput, and cmd().
    function doUndo() { if (extUndo) extUndo(); else restore(undo, redo); }
    function doRedo() { if (extRedo) extRedo(); else restore(redo, undo); }

    /* ====================================================================
       Stage-2 collaboration core (additive). A binding (md-editor-collab.js)
       drives these; with no binding they're inert. The editor stays the single
       source of truth — `text` — and these only translate to/from a host CRDT.
       ==================================================================== */
    // Rebase an absolute offset across a remote splice (the standard CRDT caret rule).
    function rebasePos(pos, index, deleteLen, insLen) {
      if (pos <= index) return pos;                       // before the edit — unmoved
      if (pos >= index + deleteLen) return pos + insLen - deleteLen;   // after — shifted
      return index + insLen;                              // inside the deleted span — clamp to insert end
    }
    // Apply ONE remote edit {index, deleteLen, insert}. Mutates text, rebases the caret,
    // re-renders, restores the caret (only if WE hold focus, so it never steals selection
    // from a peer editing in the same page), and fires NEITHER onInput NOR onChange (no echo).
    function applyRemote(index, deleteLen, insert) {
      index = Math.max(0, Math.min(index | 0, text.length));
      deleteLen = Math.max(0, Math.min(deleteLen | 0, text.length - index));
      insert = insert == null ? "" : String(insert);
      if (!deleteLen && !insert) return;
      remoteApplying = true;
      try {
        text = text.slice(0, index) + insert + text.slice(index + deleteLen);
        selA = rebasePos(selA, index, deleteLen, insert.length);
        selB = rebasePos(selB, index, deleteLen, insert.length);
        const focused = (document.activeElement === surface);
        render();
        if (focused) setCaret(selA, selB);   // keep our live caret put; render already reveals at selA/selB
      } finally {
        remoteApplying = false;
      }
    }
    // Remote-cursor overlay. setRemoteCarets([]) tears the layer's contents down (zero cost);
    // a non-empty list lazily builds an absolutely-positioned layer over the surface.
    function ensureCaretLayer() {
      if (caretLayer) return caretLayer;
      caretLayer = document.createElement("div");
      caretLayer.className = "mde-remote-layer";
      caretLayer.setAttribute("contenteditable", "false");
      caretLayer.setAttribute("aria-hidden", "true");
      (surface.parentNode || surface).appendChild(caretLayer);
      surface.addEventListener("scroll", positionRemoteCarets, { passive: true });
      if (scrollParent && scrollParent !== surface) scrollParent.addEventListener("scroll", positionRemoteCarets, { passive: true });
      window.addEventListener("resize", positionRemoteCarets);
      return caretLayer;
    }
    function rectForOffset(off) {
      const dom = offsetToDom(off);
      const r = document.createRange();
      try { r.setStart(dom.node, dom.offset); } catch (_) { return null; }
      r.collapse(true);
      const rects = r.getClientRects();
      const rect = (rects && rects.length) ? rects[rects.length - 1] : r.getBoundingClientRect();
      return (rect && (rect.height || rect.width || rect.top)) ? rect : null;
    }
    function positionRemoteCarets() {
      if (!caretLayer || !surface.isConnected) return;
      // overlay the surface's border box (sibling ⇒ shared offsetParent ⇒ matching offset coords)
      caretLayer.style.left = surface.offsetLeft + "px";
      caretLayer.style.top = surface.offsetTop + "px";
      caretLayer.style.width = surface.offsetWidth + "px";
      caretLayer.style.height = surface.offsetHeight + "px";
      caretLayer.textContent = "";
      if (!remoteCarets.length) return;
      const sb = surface.getBoundingClientRect();
      for (const c of remoteCarets) {
        if (!c) continue;
        const color = c.color || "var(--mde-green)";
        const a = Math.max(0, Math.min(+c.a || 0, text.length));
        const b = (c.b == null) ? a : Math.max(0, Math.min(+c.b || 0, text.length));
        const lo = Math.min(a, b), hi = Math.max(a, b);
        if (hi > lo) {   // colored selection highlight, one box per client rect (per visual line)
          const r = document.createRange();
          const pa = offsetToDom(lo), pb = offsetToDom(hi);
          try { r.setStart(pa.node, pa.offset); r.setEnd(pb.node, pb.offset); } catch (_) {}
          const rects = r.getClientRects();
          for (let i = 0; i < rects.length; i++) {
            const rc = rects[i]; if (!rc.width && !rc.height) continue;
            const sel = document.createElement("div");
            sel.className = "mde-remote-sel";
            sel.style.left = (rc.left - sb.left) + "px"; sel.style.top = (rc.top - sb.top) + "px";
            sel.style.width = rc.width + "px"; sel.style.height = rc.height + "px";
            sel.style.background = color;
            caretLayer.appendChild(sel);
          }
        }
        const cr = rectForOffset(b);   // 2px caret bar at the focus end
        if (cr) {
          const bar = document.createElement("div");
          bar.className = "mde-remote-caret";
          bar.style.left = (cr.left - sb.left) + "px"; bar.style.top = (cr.top - sb.top) + "px";
          bar.style.height = (cr.height || 18) + "px"; bar.style.background = color;
          caretLayer.appendChild(bar);
          if (c.name) {   // small name label riding just above the caret
            const lab = document.createElement("div");
            lab.className = "mde-remote-label"; lab.textContent = c.name;
            lab.style.left = (cr.left - sb.left) + "px"; lab.style.top = (cr.top - sb.top) + "px";
            lab.style.background = color;
            caretLayer.appendChild(lab);
          }
        }
      }
    }
    function setRemoteCarets(list) {
      remoteCarets = Array.isArray(list) ? list.filter(c => c && c.a != null) : [];
      if (!remoteCarets.length) { if (caretLayer) caretLayer.textContent = ""; return; }
      ensureCaretLayer();
      positionRemoteCarets();
    }

    /* ----- word / grapheme boundaries ----- */
    function prevG(a) {
      if (a >= 2) { const lo = text.charCodeAt(a - 1), hi = text.charCodeAt(a - 2); if (lo >= 0xDC00 && lo <= 0xDFFF && hi >= 0xD800 && hi <= 0xDBFF) return a - 2; }
      return a - 1;
    }
    function nextG(a) {
      const hi = text.charCodeAt(a); if (hi >= 0xD800 && hi <= 0xDBFF && a + 2 <= text.length) return a + 2;
      return a + 1;
    }
    function wordLeft(a) { let i = a; while (i > 0 && /\s/.test(text[i - 1])) i--; while (i > 0 && !/\s/.test(text[i - 1])) i--; return i; }
    function wordRight(a) { let i = a, n = text.length; while (i < n && /\s/.test(text[i])) i++; while (i < n && !/\s/.test(text[i])) i++; return i; }
    function lineStart(a) { return text.lastIndexOf("\n", a - 1) + 1; }
    function atomicBefore(pos) { for (const lf of leaves) if (lf.atomic && lf.s + lf.len === pos) return lf; return null; }
    function atomicAfter(pos) { for (const lf of leaves) if (lf.atomic && lf.s === pos) return lf; return null; }

    /* ----- smart lists: Enter continues a bullet/numbered list (next marker,
       numbers auto-increment); Enter on an EMPTY item exits the list. Returns
       true when it handled the keystroke, so the caller skips the plain newline. */
    function smartListEnter(pos) {
      const ls = lineStart(pos);
      let le = text.indexOf("\n", pos); if (le < 0) le = text.length;
      const line = text.slice(ls, le);
      let m, prefix;
      if ((m = line.match(/^( *)([-*+]\s+)(.*)$/))) {
        if (m[3].trim() === "") return emptyListItem(ls, le, m[1], "ul");
        prefix = m[1] + m[2];
      } else if ((m = line.match(/^( *)(\d+)\.(\s+)(.*)$/))) {
        if (m[4].trim() === "") return emptyListItem(ls, le, m[1], "ol");
        prefix = m[1] + (parseInt(m[2], 10) + 1) + "." + m[3];
      } else return false;
      const ins = "\n" + prefix;
      edit(pos, pos, ins, pos + ins.length, "nl");
      return true;
    }
    // Enter on an EMPTY list item: outdent one level if nested, else exit the list (Docs/Word).
    function emptyListItem(ls, le, lead, type) {
      if (lead.length >= LIST_INDENT) {
        const repl = lead.slice(LIST_INDENT) + (type === "ol" ? "1. " : "- ");
        edit(ls, le, repl, ls + repl.length, "nl");
      } else {
        edit(ls, le, "", ls, "nl");
      }
      return true;
    }

    /* ----- input handling (everything goes through here) ----- */
    surface.addEventListener("beforeinput", e => {
      if (cellOf(e.target)) return;   // table cells edit natively, then reserialize
      if (composing) return;
      const t = e.inputType;
      const cur = readSel() || [selA, selB];
      const a = cur[0], b = cur[1];
      if (t === "insertText") { e.preventDefault(); const d = e.data == null ? "" : e.data; edit(a, b, d, a + d.length, "type"); }
      else if (t === "insertReplacementText") { e.preventDefault(); const d = (e.dataTransfer && e.dataTransfer.getData("text")) || e.data || ""; edit(a, b, d, a + d.length, "rep"); }
      else if (t === "insertParagraph" || t === "insertLineBreak") { e.preventDefault(); if (!(a === b && smartListEnter(a))) edit(a, b, "\n", a + 1, "nl"); }
      else if (t === "deleteContentBackward") { e.preventDefault(); if (a !== b) edit(a, b, "", a, "del"); else if (a > 0) { const ch = atomicBefore(a); if (ch) edit(ch.s, a, "", ch.s, "del"); else { const p = prevG(a); edit(p, a, "", p, "del"); } } }
      else if (t === "deleteContentForward")  { e.preventDefault(); if (a !== b) edit(a, b, "", a, "del"); else if (b < text.length) { const ch = atomicAfter(b); if (ch) edit(b, ch.s + ch.len, "", a, "del"); else { const x = nextG(b); edit(b, x, "", a, "del"); } } }
      else if (t === "deleteWordBackward")    { e.preventDefault(); if (a !== b) edit(a, b, "", a, "del"); else { const p = wordLeft(a); edit(p, a, "", p, "del"); } }
      else if (t === "deleteWordForward")     { e.preventDefault(); if (a !== b) edit(a, b, "", a, "del"); else { const x = wordRight(b); edit(b, x, "", a, "del"); } }
      else if (t === "deleteSoftLineBackward" || t === "deleteHardLineBackward") { e.preventDefault(); if (a !== b) edit(a, b, "", a, "del"); else { const ls = lineStart(a); edit(ls, a, "", ls, "del"); } }
      else if (t === "historyUndo") { e.preventDefault(); doUndo(); }
      else if (t === "historyRedo") { e.preventDefault(); doRedo(); }
      else { e.preventDefault(); } // paste/cut/drop handled by their own events; ignore the rest
    });
    /* ----- DOCS-9 clean export: serialize a source range to human-clean output -----
       Plain text drops every marker, chips become their label, %% comments and style
       markers vanish, tables become tab-separated rows — so an essay pasted into Google
       Docs reads as written, never as `**`/`#`/`@{…}` soup that screams AI. A parallel
       text/html flavor keeps INTENDED formatting (bold, headings, colour) as real rich
       text. A private MIME carries the raw markdown so copy↔paste *inside* the editor
       still round-trips losslessly. */
    const MD_MIME = "application/x-mde-markdown";
    function inlineToPlain(content) {
      let out = "";
      for (const t of parseInline(content, 0)) {
        if (t.kind === "text") out += t.text;
        else if (t.kind === "chip") out += (t.ctype === "date" ? fmtDateLabel(t.cval) : t.cval);
        else if (t.kind === "comment") { /* drop */ }
        else if (t.kind === "code") out += t.inner;
        else if (t.kind === "link") out += t.ltext;
        else if (t.kind === "style") out += inlineToPlain(t.inner);
        else out += inlineToPlain(t.inner);   // strong / em / del
      }
      return out;
    }
    function inlineToHtml(content) {
      let out = "";
      for (const t of parseInline(content, 0)) {
        if (t.kind === "text") out += esc(t.text);
        else if (t.kind === "chip") out += esc(t.ctype === "date" ? fmtDateLabel(t.cval) : t.cval);
        else if (t.kind === "comment") { /* drop */ }
        else if (t.kind === "code") out += "<code>" + esc(t.inner) + "</code>";
        else if (t.kind === "link") out += '<a href="' + esc(t.url) + '">' + esc(t.ltext) + "</a>";
        else if (t.kind === "style") { const css = styleSpecToCss(t.spec); out += css ? "<span style='" + css + "'>" + inlineToHtml(t.inner) + "</span>" : inlineToHtml(t.inner); }
        else if (t.kind === "strong") out += "<strong>" + inlineToHtml(t.inner) + "</strong>";
        else if (t.kind === "del") out += "<del>" + inlineToHtml(t.inner) + "</del>";
        else out += "<em>" + inlineToHtml(t.inner) + "</em>";
      }
      return out;
    }
    function tableRunEnd(lines, i) {   // [hdrIdx, bodyEnd) for a table starting at line i, or null
      const colsMeta = isColsLine(lines[i]) && i + 2 < lines.length && isRow(lines[i + 1]) && isDelim(lines[i + 2]);
      const tableTop = isRow(lines[i]) && i + 1 < lines.length && isDelim(lines[i + 1]);
      if (!colsMeta && !tableTop) return null;
      const hdr = colsMeta ? i + 1 : i;
      let j = hdr + 2; while (j < lines.length && isRow(lines[j])) j++;
      return [hdr, j];
    }
    function rangeToPlain(md) {
      const lines = md.split("\n"), out = []; let i = 0;
      const hidden = commentLines(lines);
      while (i < lines.length) {
        if (hidden[i]) { i++; continue; }   // <!--…--> comment block: never exported
        const tr = tableRunEnd(lines, i);
        if (tr) {
          const [hdr, j] = tr;
          out.push(splitCells(lines[hdr]).map(inlineToPlain).join("\t"));
          for (let k = hdr + 2; k < j; k++) out.push(splitCells(lines[k]).map(inlineToPlain).join("\t"));
          i = j; continue;
        }
        const ln = lines[i], b = classify(ln, 0, ln.length);
        if (b.type === "meta") { i++; continue; }                 // drop %%…%% line
        if (b.type === "hr") { out.push(""); i++; continue; }
        if (b.type === "h" || b.type === "bq") out.push(inlineToPlain(ln.slice(b.mlen)));
        else if (b.type === "li") out.push("• " + inlineToPlain(ln.slice(b.mlen)));
        else if (b.type === "ol") { const m = ln.match(/^\s*(\d+)\./); out.push((m ? m[1] : "1") + ". " + inlineToPlain(ln.slice(b.mlen))); }
        else if (b.type === "blank") out.push("");
        else out.push(inlineToPlain(ln));
        i++;
      }
      return out.join("\n");
    }
    function rangeToHtml(md) {
      const lines = md.split("\n"); let html = "", i = 0, listType = null, buf = [];
      const hidden = commentLines(lines);
      const flush = () => { if (listType) { html += "<" + listType + ">" + buf.join("") + "</" + listType + ">"; listType = null; buf = []; } };
      while (i < lines.length) {
        if (hidden[i]) { i++; continue; }   // <!--…--> comment block: never exported
        const tr = tableRunEnd(lines, i);
        if (tr) {
          flush(); const [hdr, j] = tr;
          let t = "<table><thead><tr>"; splitCells(lines[hdr]).forEach(c => t += "<th>" + inlineToHtml(c) + "</th>"); t += "</tr></thead><tbody>";
          for (let k = hdr + 2; k < j; k++) { t += "<tr>"; splitCells(lines[k]).forEach(c => t += "<td>" + inlineToHtml(c) + "</td>"); t += "</tr>"; }
          html += t + "</tbody></table>"; i = j; continue;
        }
        const ln = lines[i], b = classify(ln, 0, ln.length);
        if (b.type === "li") { if (listType !== "ul") { flush(); listType = "ul"; } buf.push("<li>" + inlineToHtml(ln.slice(b.mlen)) + "</li>"); i++; continue; }
        if (b.type === "ol") { if (listType !== "ol") { flush(); listType = "ol"; } buf.push("<li>" + inlineToHtml(ln.slice(b.mlen)) + "</li>"); i++; continue; }
        flush();
        if (b.type === "meta") { /* drop */ }
        else if (b.type === "h") html += "<h" + b.lvl + ">" + inlineToHtml(ln.slice(b.mlen)) + "</h" + b.lvl + ">";
        else if (b.type === "bq") html += "<blockquote>" + inlineToHtml(ln.slice(b.mlen)) + "</blockquote>";
        else if (b.type === "hr") html += "<hr>";
        else if (b.type === "blank") { /* skip */ }
        else html += "<p>" + inlineToHtml(ln) + "</p>";
        i++;
      }
      flush();
      return html;
    }
    function writeClipboard(e, a, b) {
      const md = text.slice(a, b);
      e.clipboardData.setData("text/plain", rangeToPlain(md));
      try { e.clipboardData.setData("text/html", rangeToHtml(md)); } catch (_) {}
      try { e.clipboardData.setData(MD_MIME, md); } catch (_) {}   // internal round-trip
    }

    surface.addEventListener("paste", e => {
      if (cellOf(e.target)) return;
      e.preventDefault();
      const cd = e.clipboardData || window.clipboardData;
      let d = (cd.getData(MD_MIME) || "");           // paste WITHIN the editor → raw markdown
      if (!d) d = (cd.getData("text/plain") || "");  // from elsewhere → as typed
      d = d.replace(/\r\n?/g, "\n");
      const cur = readSel() || [selA, selB];
      edit(cur[0], cur[1], d, null, "paste");
    });
    surface.addEventListener("copy", e => {
      if (cellOf(e.target)) return;
      const cur = readSel(); if (!cur || cur[0] === cur[1]) return;
      e.preventDefault(); writeClipboard(e, cur[0], cur[1]);
    });
    surface.addEventListener("cut", e => {
      if (cellOf(e.target)) return;
      const cur = readSel(); if (!cur) return;
      e.preventDefault();
      if (cur[0] !== cur[1]) { writeClipboard(e, cur[0], cur[1]); edit(cur[0], cur[1], "", cur[0], "cut"); }
    });
    surface.addEventListener("drop", e => {
      if (cellOf(e.target)) return;
      const d = e.dataTransfer && e.dataTransfer.getData("text/plain");
      if (!d) return;
      e.preventDefault(); const cur = readSel() || [selA, selB]; edit(cur[0], cur[1], d.replace(/\r\n?/g, "\n"), null, "drop");
    });
    surface.addEventListener("compositionstart", e => { if (cellOf(e.target)) return; composing = true; compAt = readSel() || [selA, selB]; });
    surface.addEventListener("compositionend", e => {
      if (cellOf(e.target)) return;
      composing = false; const c = compAt || [selA, selB]; compAt = null;
      edit(c[0], c[1], e.data || "", null, "type");
    });
    surface.addEventListener("keydown", e => {
      if (gridOpen) {
        if (e.key === "Escape") { e.preventDefault(); closeGrid(); return; }
        // arrow keys grow/shrink the selection: rows run vertically, columns horizontally
        if (e.key === "ArrowDown")  { e.preventDefault(); gR = Math.min(GMAX, gR + 1); paintGrid(); return; }
        if (e.key === "ArrowUp")    { e.preventDefault(); gR = Math.max(1, gR - 1); paintGrid(); return; }
        if (e.key === "ArrowRight") { e.preventDefault(); gC = Math.min(GMAX, gC + 1); paintGrid(); return; }
        if (e.key === "ArrowLeft")  { e.preventDefault(); gC = Math.max(1, gC - 1); paintGrid(); return; }
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insertTable(gR, gC); return; }
      }
      if (menuOpen) {
        if (e.key === "ArrowDown") { e.preventDefault(); if (items.length) { msel = (msel + 1) % items.length; highlightMenu(); } return; }
        if (e.key === "ArrowUp")   { e.preventDefault(); if (items.length) { msel = (msel - 1 + items.length) % items.length; highlightMenu(); } return; }
        if (e.key === "Enter" || e.key === "Tab") { if (items.length) { e.preventDefault(); commit(msel); return; } }
        if (e.key === "Escape") { e.preventDefault(); closeMenu(); return; }
      }
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "z" || e.key === "Z")) { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
      if (mod && e.key === "y") { e.preventDefault(); doRedo(); return; }
      if (mod && (e.key === "b" || e.key === "B")) { e.preventDefault(); wrap("**"); return; }
      if (mod && (e.key === "i" || e.key === "I")) { e.preventDefault(); wrap("*"); return; }
      if (mod && (e.key === "s" || e.key === "S")) { e.preventDefault(); onSave(); return; }
      // DOCS-4 — Option+/ opens the command palette. e.code dodges the Mac dead-key (⌥/ = "÷").
      if (e.altKey && !e.metaKey && !e.ctrlKey && (e.code === "Slash" || e.key === "/")) { e.preventDefault(); openPalette(); return; }
      // DOCS-WC — Cmd/Ctrl+Shift+C opens the Google-Docs-style word-count modal.
      if (mod && e.shiftKey && (e.code === "KeyC" || e.key === "c" || e.key === "C")) { e.preventDefault(); openWordCount(); return; }
      if (e.key === "Tab") {
        e.preventDefault();
        const c = readSel() || [selA, selB], lr = curLineRange(c[0]), ln = text.slice(lr[0], lr[1]);
        if (/^ *([-*+]\s+|\d+\.\s+)/.test(ln)) {                      // in a list item → indent / outdent the line
          const lead = (ln.match(/^ */) || [""])[0].length;
          if (e.shiftKey) { const strip = Math.min(LIST_INDENT, lead); if (strip) edit(lr[0], lr[0] + strip, "", Math.max(lr[0], c[0] - strip), "block"); }
          else if (lead < LIST_INDENT * 6) edit(lr[0], lr[0], " ".repeat(LIST_INDENT), c[0] + LIST_INDENT, "block");
        } else if (!e.shiftKey) { edit(c[0], c[1], "  ", c[0] + 2, "type"); }
        return;
      }
    });
    function wrap(mk) {
      const c = readSel() || [selA, selB], a = c[0], b = c[1];
      if (a === b) edit(a, b, mk + mk, a + mk.length, "wrap");
      else edit(a, b, mk + text.slice(a, b) + mk, b + 2 * mk.length, "wrap");
    }

    /* ----- DOCS-8 apply / clear invisible styling (driven by the palette/toolbar) ----- */
    // scan the whole source for balanced @{s:…}…@{/s} spans (innermost-resolvable)
    function scanStyleSpans(txt) {
      const spans = [], stack = []; let i = 0; const n = txt.length;
      while (i < n) {
        if (txt[i] === "@" && txt[i + 1] === "{") {
          if (txt.startsWith("s:", i + 2)) { const cl = txt.indexOf("}", i + 2); if (cl > 0) { stack.push({ s: i, openEnd: cl + 1 }); i = cl + 1; continue; } }
          else if (txt.startsWith("/s}", i + 2)) { const o = stack.pop(); if (o) spans.push({ s: o.s, openEnd: o.openEnd, closeStart: i, e: i + 5 }); i += 5; continue; }
        }
        i++;
      }
      return spans;
    }
    // wrap the current selection in a style span; merge into an exactly-enclosing span so
    // colour+font+size stack into ONE @{s:…} rather than nesting markers.
    function applyStyle(props) {
      const c = readSel() || [selA, selB]; let a = c[0], b = c[1];
      if (a === b) return;                                  // styling needs a selection
      const exact = scanStyleSpans(text).find(sp => sp.openEnd === a && sp.closeStart === b);
      if (exact) {                                          // already wrapped → merge specs
        const cur = parseStyleSpec(text.slice(exact.s + 4, exact.openEnd - 1));
        for (const k in props) { if (props[k] === null) delete cur[k]; else cur[k] = props[k]; }
        const spec = styleSpecToStr(cur);
        if (!spec) return clearRange(exact);
        const open = "@{s:" + spec + "}";
        snapshot("style");
        text = text.slice(0, exact.s) + open + text.slice(exact.openEnd);
        render(); setCaret(exact.s + open.length, exact.s + open.length + (b - a)); onInput();
        return;
      }
      const spec = styleSpecToStr(props); if (!spec) return;
      const open = "@{s:" + spec + "}", inner = text.slice(a, b);
      snapshot("style");
      text = text.slice(0, a) + open + inner + "@{/s}" + text.slice(b);
      render(); setCaret(a + open.length, a + open.length + inner.length); onInput();  // keep inner selected so styles stack
    }
    function clearRange(sp) {   // remove both markers of one span, keep inner
      snapshot("style");
      text = text.slice(0, sp.closeStart) + text.slice(sp.e);    // close first (higher offset)
      text = text.slice(0, sp.s) + text.slice(sp.openEnd);
      const openLen = sp.openEnd - sp.s;
      render(); setCaret(sp.openEnd - openLen, sp.closeStart - openLen); onInput();
    }
    function clearStyle() {   // unwrap the innermost style span enclosing the selection
      const c = readSel() || [selA, selB], a = c[0], b = c[1];
      let target = null;
      for (const sp of scanStyleSpans(text))
        if (sp.s <= a && sp.e >= b && (!target || (sp.e - sp.s) < (target.e - target.s))) target = sp;
      if (target) clearRange(target);
    }

    /* ----- block-format ops (also exposed through the palette) ----- */
    function curLineRange(pos) { const s = lineStart(pos); let e = text.indexOf("\n", pos); if (e < 0) e = text.length; return [s, e]; }
    const BLOCK_RE = /^(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/;
    function setHeading(lvl) {
      const c = readSel() || [selA, selB], lr = curLineRange(c[0]);
      const body = text.slice(lr[0], lr[1]).replace(BLOCK_RE, "");
      const had = /^#{1,6}\s+/.test(text.slice(lr[0], lr[1]));
      const lvlNow = had ? (text.slice(lr[0], lr[1]).match(/^#+/) || [""])[0].length : 0;
      const nl = (lvlNow === lvl) ? body : ("#".repeat(lvl) + " " + body);   // same level toggles off
      edit(lr[0], lr[1], nl, lr[0] + nl.length, "block");
    }
    function togglePrefix(re, prefix) {
      const c = readSel() || [selA, selB], lr = curLineRange(c[0]);
      const ln = text.slice(lr[0], lr[1]);
      const nl = re.test(ln) ? ln.replace(re, "") : (prefix + ln.replace(BLOCK_RE, ""));
      edit(lr[0], lr[1], nl, lr[0] + nl.length, "block");
    }
    function insertLink() {
      const c = readSel() || [selA, selB], a = c[0], b = c[1], sel = text.slice(a, b) || "text";
      const pre = "[" + sel + "](";
      edit(a, b, pre + "url)", a + pre.length + 3, "link");
      setCaret(a + pre.length, a + pre.length + 3);   // select "url"
    }
    function insertRule() {
      const c = readSel() || [selA, selB], a = c[0];
      const atBol = a === 0 || text[a - 1] === "\n";
      const ins = (atBol ? "" : "\n") + "---\n";
      edit(a, a, ins, a + ins.length, "block");
    }

    let rafPending = false;
    document.addEventListener("selectionchange", () => {
      if (suppress || composing) return;
      const s = document.getSelection();
      if (!s || s.rangeCount === 0 || !surface.contains(s.anchorNode)) return;
      if (rafPending) return; rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        if (selInCell()) { closeMenu(); return; }
        const cur = readSel(); if (!cur) return;
        selA = cur[0]; selB = cur[1]; applyReveal(); syncMenu(); notifyCaret(); if (wcCaretRefresh) wcCaretRefresh();
      });
    });

    /* ============== smart "@" menu + dates + table grid picker ============== */
    const ICON_CAL = '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="16" rx="2.5"/><path d="M3.5 9.5h17M8 3.5v3M16 3.5v3"/></svg>';
    const ICON_TABLE = '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M3.5 14.5h17M9 9.5V19.5M15 9.5V19.5"/></svg>';
    const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
    const pad2 = n => String(n).padStart(2, "0");
    function todayISO() { const t = new Date(); return t.getFullYear() + "-" + pad2(t.getMonth() + 1) + "-" + pad2(t.getDate()); }
    function fmtDateLabel(iso) {
      const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(iso); if (!m) return iso;
      return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }
    function personOf(name) { return PEOPLE.find(p => p.name === name) || null; }
    // a person may carry { accent, accentBg, accentBorder }; apply as per-chip CSS vars
    function applyAccent(el, name) {
      const p = personOf(name);
      if (!p || !p.accent) return;
      el.classList.add("chip-accent");
      el.style.setProperty("--mde-chip-accent", p.accent);
      if (p.accentBg) el.style.setProperty("--mde-chip-accent-bg", p.accentBg);
      if (p.accentBorder) el.style.setProperty("--mde-chip-accent-border", p.accentBorder);
    }
    function initials(name) { return name.split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join("").toUpperCase(); }
    function parseDate(q) {
      const s = (q || "").trim().toLowerCase(); if (!s) return null;
      const now = new Date(), yNow = now.getFullYear();
      const mk = d => iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
      const iso = (y, mo, d) => (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) ? { iso: y + "-" + pad2(mo) + "-" + pad2(d), label: fmtDateLabel(y + "-" + pad2(mo) + "-" + pad2(d)) } : null;
      const mIdx = nm => MONTHS.indexOf(nm.slice(0, 3));
      if (s === "today") return mk(now);
      if (s === "tomorrow") { const d = new Date(now); d.setDate(d.getDate() + 1); return mk(d); }
      if (s === "yesterday") { const d = new Date(now); d.setDate(d.getDate() - 1); return mk(d); }
      let m;
      if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return iso(+m[1], +m[2], +m[3]);
      if ((m = s.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/))) { let y = m[3] ? +m[3] : yNow; if (y < 100) y += 2000; return iso(y, +m[1], +m[2]); }
      if ((m = s.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/))) { const mi = mIdx(m[1]); if (mi >= 0) return iso(m[3] ? +m[3] : yNow, mi + 1, +m[2]); }
      if ((m = s.match(/^(\d{1,2})\s+([a-z]{3,9})\.?(?:,?\s+(\d{4}))?$/))) { const mi = mIdx(m[2]); if (mi >= 0) return iso(m[3] ? +m[3] : yNow, mi + 1, +m[1]); }
      return null;
    }

    const menu = document.createElement("div"); menu.className = "at-menu"; document.body.appendChild(menu);
    let menuOpen = false, atPos = -1, items = [], msel = 0;

    function buildItems(q) {
      const out = [], ql = q.toLowerCase().trim();
      for (const p of PEOPLE) if (!ql || (p.name + " " + (p.email || "")).toLowerCase().includes(ql))
        out.push({ group: "People", kind: "person", lab: p.name, sub: p.email || "", person: p });
      const pd = parseDate(q);
      if (pd) out.push({ group: "Date", kind: "date", lab: pd.label, sub: "Insert date", iso: pd.iso });
      if (!ql || "today".startsWith(ql) || "date".startsWith(ql)) {
        const t = todayISO(); if (!pd || pd.iso !== t) out.push({ group: "Date", kind: "date", lab: "Today — " + fmtDateLabel(t), sub: "Insert date", iso: t });
      }
      if (!ql || "table".startsWith(ql) || "grid".startsWith(ql)) out.push({ group: "Insert", kind: "table", lab: "Table", sub: "Choose a size" });
      return out;
    }
    function renderMenu() {
      if (!items.length) { menu.innerHTML = '<div class="at-empty">No matches — keep typing or press Esc</div>'; return; }
      let html = "", lastG = null;
      items.forEach((it, i) => {
        if (it.group !== lastG) { html += '<div class="at-group">' + it.group + "</div>"; lastG = it.group; }
        const avAccent = it.person && it.person.accent ? ' style="background:' + esc(it.person.accent) + '"' : "";
        const left = it.kind === "person"
          ? '<div class="at-avatar"' + avAccent + ">" + esc(initials(it.person.name)) + "</div>"
          : '<div class="at-ico">' + (it.kind === "date" ? ICON_CAL : ICON_TABLE) + "</div>";
        html += '<div class="at-item' + (i === msel ? " sel" : "") + '" data-i="' + i + '">' + left +
          '<div class="at-tw"><div class="at-lab">' + esc(it.lab) + "</div>" + (it.sub ? '<div class="at-sub">' + esc(it.sub) + "</div>" : "") + "</div></div>";
      });
      menu.innerHTML = html;
      menu.querySelectorAll(".at-item").forEach(el => {
        el.addEventListener("mousedown", e => { e.preventDefault(); commit(+el.dataset.i); });
        el.addEventListener("mousemove", () => { msel = +el.dataset.i; highlightMenu(); });
      });
    }
    function highlightMenu() { menu.querySelectorAll(".at-item").forEach(el => el.classList.toggle("sel", +el.dataset.i === msel)); }
    function caretRect() {
      const s = document.getSelection(); if (!s || !s.rangeCount) return null;
      const r = s.getRangeAt(0).getClientRects()[0] || s.getRangeAt(0).getBoundingClientRect();
      return (r && (r.width || r.height || r.top)) ? r : surface.getBoundingClientRect();
    }
    function placeNear(el) {
      const r = caretRect(); if (!r) return;
      const w = el.offsetWidth || 300, h = el.offsetHeight || 200;
      let left = r.left, top = r.bottom + 6;
      if (left + w > window.innerWidth - 12) left = window.innerWidth - w - 12;
      if (top + h > window.innerHeight - 12) top = r.top - h - 6;
      el.style.left = Math.max(12, left) + "px"; el.style.top = Math.max(12, top) + "px";
    }
    function atContext(caret) {
      let i = caret; const min = Math.max(0, caret - 30);
      while (i > min) {
        const ch = text[i - 1];
        if (ch === "\n") return null;
        if (ch === "@") {
          if (text[i] === "{") return null;                 // inside a @{...} chip
          const before = i >= 2 ? text[i - 2] : "";
          if (i - 1 === 0 || /[\s(>\-\[]/.test(before)) return { at: i - 1, query: text.slice(i, caret) };
          return null;
        }
        i--;
      }
      return null;
    }
    function syncMenu() {
      if (suppress) return;
      if (gridOpen) return;
      const cur = readSel();
      if (!cur || cur[0] !== cur[1]) { closeMenu(); return; }
      const ctx = atContext(cur[0]);
      if (!ctx) { closeMenu(); return; }
      const query = ctx.query;
      if (/\n/.test(query) || query.length > 28 || /\s{2,}/.test(query)) { closeMenu(); return; }
      items = buildItems(query);
      if (!items.length && /\s/.test(query)) { closeMenu(); return; }
      atPos = ctx.at;
      if (!menuOpen) { menuOpen = true; msel = 0; menu.classList.add("open"); }
      msel = Math.min(msel, Math.max(0, items.length - 1));
      renderMenu(); placeNear(menu);
    }
    function closeMenu() { if (menuOpen) { menuOpen = false; menu.classList.remove("open"); } }
    function commit(i) {
      const it = items[i]; if (!it) return;
      const cur = readSel(); const to = cur ? cur[1] : selA, from = atPos;
      if (it.kind === "person") { const tok = "@{person:" + it.person.name + "}"; closeMenu(); edit(from, to, tok, from + tok.length, "chip"); }
      else if (it.kind === "date") { const tok = "@{date:" + it.iso + "}"; closeMenu(); edit(from, to, tok, from + tok.length, "chip"); }
      else if (it.kind === "table") { closeMenu(); openGrid(from, to); }
    }

    /* ---- table grid-size picker ---- */
    const gridPop = document.createElement("div"); gridPop.className = "grid-pop"; document.body.appendChild(gridPop);
    let gridOpen = false, gridFrom = 0, gridTo = 0, gR = 1, gC = 1; const GMAX = 8;
    function openGrid(from, to) {
      gridFrom = from; gridTo = to; gR = 1; gC = 1; gridOpen = true;
      gridPop.innerHTML = '<div class="grid-cells"></div><div class="grid-label">1 × 1</div>';
      const cells = gridPop.querySelector(".grid-cells");
      cells.style.gridTemplateColumns = "repeat(" + GMAX + ", 17px)";
      for (let r = 0; r < GMAX; r++) for (let c = 0; c < GMAX; c++) {
        const cell = document.createElement("div"); cell.className = "grid-cell"; cell.dataset.r = r + 1; cell.dataset.c = c + 1;
        cell.addEventListener("mousemove", () => { gR = +cell.dataset.r; gC = +cell.dataset.c; paintGrid(); });
        cell.addEventListener("mousedown", e => { e.preventDefault(); insertTable(gR, gC); });
        cells.appendChild(cell);
      }
      paintGrid(); gridPop.classList.add("open"); placeNear(gridPop);
    }
    function paintGrid() {
      gridPop.querySelectorAll(".grid-cell").forEach(c => c.classList.toggle("on", +c.dataset.r <= gR && +c.dataset.c <= gC));
      gridPop.querySelector(".grid-label").textContent = gR + " × " + gC;
    }
    function closeGrid() { if (gridOpen) { gridOpen = false; gridPop.classList.remove("open"); } }
    function insertTable(rows, cols) {
      closeGrid();
      const emptyRow = "|" + " |".repeat(cols);
      const delim = "|" + " --- |".repeat(cols);
      const lines = [emptyRow, delim];
      for (let i = 1; i < rows; i++) lines.push(emptyRow);
      const tbl = lines.join("\n");
      const nlBefore = gridFrom > 0 && text[gridFrom - 1] !== "\n";
      const nlAfter = gridTo < text.length && text[gridTo] !== "\n";
      const ins = (nlBefore ? "\n" : "") + tbl + (nlAfter ? "\n" : "");
      const ts = gridFrom + (nlBefore ? 1 : 0);
      edit(gridFrom, gridTo, ins, ts, "table");
      const w = surface.querySelector('.mtable-wrap[data-s="' + ts + '"]');
      if (w) focusCell(w.querySelector(".mcell"));
    }

    /* ================= DOCS-6 real dark mode (token swap; opt-in, persisted) =================
       The dark --mde-* set lives in CSS (.mde-dark / prefers-color-scheme). Here we only
       flip a class on <html> so the body-mounted popovers inherit it too, and remember the
       choice. "auto" (no class) lets the OS preference drive it. */
    function getTheme() { try { return localStorage.getItem("mde-theme") || "auto"; } catch (_) { return "auto"; } }
    function applyThemeClass(name) {
      const r = document.documentElement;
      r.classList.toggle("mde-dark", name === "dark");
      r.classList.toggle("mde-light", name === "light");
    }
    function setTheme(name) {
      if (name !== "dark" && name !== "light") name = "auto";
      try { name === "auto" ? localStorage.removeItem("mde-theme") : localStorage.setItem("mde-theme", name); } catch (_) {}
      applyThemeClass(name);
    }
    function prefersDark() { return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches); }
    function isDark() { const r = document.documentElement; return r.classList.contains("mde-dark") || (getTheme() === "auto" && !r.classList.contains("mde-light") && prefersDark()); }
    function toggleTheme() { setTheme(isDark() ? "light" : "dark"); }
    applyThemeClass(getTheme());   // honor a prior choice; "auto" is a no-op

    /* ================= DOCS-4 Option+/ command palette ================= */
    /* Fuzzy over every editor action, frequency-weighted (persisted). It is the single
       keyboard surface that drives DOCS-8 styling — colour/font/size are submenus here,
       so users never type or see the @{s:…} syntax. */
    const pal = document.createElement("div"); pal.className = "mde-cmdpal"; document.body.appendChild(pal);
    let palOpen = false, palItems = [], palSel = 0, palStack = [], palQuery = "", palInput = null, palList = null;
    function loadUsage() { try { return JSON.parse(localStorage.getItem("mde-cmd-usage") || "{}") || {}; } catch (_) { return {}; } }
    let palUsage = loadUsage();
    function bumpUsage(id) { palUsage[id] = (palUsage[id] || 0) + 1; try { localStorage.setItem("mde-cmd-usage", JSON.stringify(palUsage)); } catch (_) {} }

    const PAL_COLORS = [["Red", "#c0392b"], ["Orange", "#b9770e"], ["Green", "#1e7d4f"], ["Teal", "#127d82"], ["Blue", "#1f6feb"], ["Purple", "#7b3fb0"], ["Pink", "#c026a6"], ["Slate", "#4b5563"]];
    const PAL_HILITES = [["Yellow", "#fff3a3"], ["Green", "#cde6c4"], ["Blue", "#cfe4ff"], ["Pink", "#ffd6ec"], ["Orange", "#ffe0bd"]];
    const PAL_FONTS = [["Sans", "sans"], ["Serif", "serif"], ["Mono", "mono"], ["Poppins", "poppins"], ["Georgia", "georgia"], ["Times", "times"], ["Arial", "arial"], ["Courier", "courier"]];
    const PAL_SIZES = [["Small", "0.85"], ["Normal", null], ["Large", "1.3"], ["Huge", "1.7"]];
    const swatch = hex => '<span class="mde-cmd-sw" style="background:' + esc(hex) + '"></span>';
    const subItem = (id, title, run, ico) => ({ id, title, group: "", run, keywords: "", ico: ico || "" });

    function rootCommands() {
      const c = [], add = (id, title, group, run, keywords) => c.push({ id, title, group, run, keywords: keywords || "" });
      add("bold", "Bold", "Format", () => wrap("**"), "strong weight");
      add("italic", "Italic", "Format", () => wrap("*"), "emphasis oblique");
      add("strike", "Strikethrough", "Format", () => wrap("~~"), "del cross out");
      add("code", "Inline code", "Format", () => wrap("`"), "monospace");
      add("h1", "Heading 1", "Format", () => setHeading(1), "title");
      add("h2", "Heading 2", "Format", () => setHeading(2), "subtitle");
      add("h3", "Heading 3", "Format", () => setHeading(3), "");
      add("bullets", "Bullet list", "Format", () => togglePrefix(/^(\s*)[-*+]\s+/, "- "), "unordered ul");
      add("numbers", "Numbered list", "Format", () => togglePrefix(/^(\s*)\d+\.\s+/, "1. "), "ordered ol");
      add("quote", "Quote", "Format", () => togglePrefix(/^(\s*)>\s?/, "> "), "blockquote");
      add("color", "Text color…", "Style", () => pushSub("Text color", PAL_COLORS.map(([n, hex]) => subItem("color-" + n, n, () => applyStyle({ c: hex }), swatch(hex))).concat([subItem("color-none", "Default color", () => applyStyle({ c: null }))])), "colour foreground");
      add("hilite", "Highlight…", "Style", () => pushSub("Highlight", PAL_HILITES.map(([n, hex]) => subItem("hl-" + n, n, () => applyStyle({ bg: hex }), swatch(hex))).concat([subItem("hl-none", "No highlight", () => applyStyle({ bg: null }))])), "background marker");
      add("font", "Font…", "Style", () => pushSub("Font", PAL_FONTS.map(([n, key]) => subItem("font-" + key, n, () => applyStyle({ f: key })))), "typeface family");
      add("size", "Font size…", "Style", () => pushSub("Font size", PAL_SIZES.map(([n, v]) => subItem("size-" + n, n, () => applyStyle({ sz: v })))), "scale bigger smaller");
      add("clearfmt", "Clear formatting", "Style", () => clearStyle(), "remove reset plain");
      add("table", "Insert table", "Insert", () => { const s = readSel() || [selA, selB]; openGrid(s[0], s[1]); }, "grid");
      add("link", "Insert link", "Insert", () => insertLink(), "url hyperlink");
      add("rule", "Horizontal rule", "Insert", () => insertRule(), "divider hr line");
      add("date", "Insert today's date", "Insert", () => { const s = readSel() || [selA, selB]; const tok = "@{date:" + todayISO() + "}"; edit(s[0], s[1], tok, s[0] + tok.length, "chip"); }, "today calendar");
      add("dark", "Toggle dark mode", "View", () => toggleTheme(), "theme night light");
      add("acceptmd", (acceptMd ? "Show raw markdown marks" : "Hide markdown marks (easter egg)"), "View", () => setAcceptMarkdown(!acceptMd), "markdown asterisk raw syntax accept reveal");
      add("copyplain", "Copy clean text", "Export", () => copyCleanAll(), "plain export paste docs");
      return c;
    }
    function copyCleanAll() {
      const md = (selA !== selB) ? text.slice(selA, selB) : text;
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(rangeToPlain(md)).catch(() => {});
    }
    function fuzzy(q, s) {
      q = q.toLowerCase(); s = (s || "").toLowerCase(); if (!q) return 0;
      let qi = 0, score = 0, prev = -2;
      for (let si = 0; si < s.length && qi < q.length; si++) {
        if (s[si] === q[qi]) { score += (si === prev + 1) ? 3 : 1; if (si === 0 || /\s/.test(s[si - 1])) score += 2; prev = si; qi++; }
      }
      return qi === q.length ? score : -1;
    }
    function currentSource() { return palStack.length ? palStack[palStack.length - 1].items : rootCommands(); }
    function rankItems(q) {
      const src = currentSource();
      if (palStack.length) return src.filter(it => !q || fuzzy(q, it.title) >= 0);   // submenu: plain filter
      const scored = [];
      for (const it of src) {
        const base = q ? Math.max(fuzzy(q, it.title), fuzzy(q, it.keywords) - 1) : 0;
        if (q && base < 0) continue;
        scored.push({ it, score: base + Math.min(palUsage[it.id] || 0, 8) * (q ? 0.5 : 1) });
      }
      scored.sort((a, b) => b.score - a.score || a.it.title.localeCompare(b.it.title));
      return scored.map(x => x.it);
    }
    function buildPaletteDom() {
      pal.innerHTML =
        '<div class="mde-cmd-head"><svg class="mde-cmd-mag" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.2-4.2"/></svg>' +
        '<input class="mde-cmd-input" placeholder="Search actions…" spellcheck="false"></div><div class="mde-cmd-list"></div>';
      palInput = pal.querySelector(".mde-cmd-input"); palList = pal.querySelector(".mde-cmd-list");
      palInput.addEventListener("input", () => { palQuery = palInput.value; palSel = 0; renderPalette(); });
      palInput.addEventListener("keydown", onPaletteKey);
    }
    function renderPalette() {
      palItems = rankItems(palQuery.trim());
      let html = "";
      if (palStack.length) html += '<div class="mde-cmd-crumb">‹ ' + esc(palStack[palStack.length - 1].title) + "</div>";
      if (!palItems.length) html += '<div class="mde-cmd-empty">No actions — press Esc</div>';
      let lastG = null;
      palItems.forEach((it, i) => {
        if (it.group && it.group !== lastG) { html += '<div class="mde-cmd-group">' + esc(it.group) + "</div>"; lastG = it.group; }
        html += '<div class="mde-cmd-item' + (i === palSel ? " sel" : "") + '" data-i="' + i + '">' +
          (it.ico || "") + '<span class="mde-cmd-t">' + esc(it.title) + "</span></div>";
      });
      palList.innerHTML = html;
      palList.querySelectorAll(".mde-cmd-item").forEach(el => {
        el.addEventListener("mousedown", e => { e.preventDefault(); runPalette(+el.dataset.i); });
        el.addEventListener("mousemove", () => { palSel = +el.dataset.i; highlightPalette(); });
      });
      ensurePalVisible();
    }
    function highlightPalette() { palList.querySelectorAll(".mde-cmd-item").forEach(el => el.classList.toggle("sel", +el.dataset.i === palSel)); }
    function ensurePalVisible() { const el = palList && palList.querySelector(".mde-cmd-item.sel"); if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" }); }
    function pushSub(title, items) { palStack.push({ title, items }); palQuery = ""; if (palInput) palInput.value = ""; palSel = 0; renderPalette(); }
    function onPaletteKey(e) {
      if (e.key === "ArrowDown") { e.preventDefault(); if (palItems.length) { palSel = (palSel + 1) % palItems.length; highlightPalette(); ensurePalVisible(); } }
      else if (e.key === "ArrowUp") { e.preventDefault(); if (palItems.length) { palSel = (palSel - 1 + palItems.length) % palItems.length; highlightPalette(); ensurePalVisible(); } }
      else if (e.key === "Enter") { e.preventDefault(); runPalette(palSel); }
      else if (e.key === "Escape") { e.preventDefault(); if (palStack.length) { palStack.pop(); palQuery = ""; palInput.value = ""; renderPalette(); } else closePalette(); }
      else if (e.key === "Backspace" && !palInput.value && palStack.length) { e.preventDefault(); palStack.pop(); palQuery = ""; renderPalette(); }
    }
    function runPalette(i) {
      const it = palItems[i]; if (!it) return;
      if (!palStack.length) bumpUsage(it.id);
      const before = palStack.length;
      it.run();
      if (palStack.length <= before) closePalette();   // a leaf action ran (no submenu opened)
    }
    function openPalette() {
      if (!palList) buildPaletteDom();
      palStack = []; palQuery = ""; palSel = 0; palOpen = true; palInput.value = "";
      pal.classList.add("open"); renderPalette();
      const w = pal.offsetWidth || 440;
      pal.style.left = Math.max(12, (window.innerWidth - w) / 2) + "px";
      pal.style.top = Math.min(140, Math.round(window.innerHeight * 0.16)) + "px";
      palInput.focus();
    }
    function closePalette() { if (!palOpen) return; palOpen = false; pal.classList.remove("open"); palStack = []; surface.focus(); }

    document.addEventListener("mousedown", e => {
      if ((menuOpen && !menu.contains(e.target)) || (gridOpen && !gridPop.contains(e.target) && !surface.contains(e.target))) { closeMenu(); closeGrid(); }
      if (palOpen && !pal.contains(e.target)) closePalette();
    }, true);
    const stage = scrollParent || surface.closest(".editor-stage") || surface.parentElement;
    if (stage) stage.addEventListener("scroll", () => { closeMenu(); closeGrid(); });
    function dismiss() { closeMenu(); closeGrid(); closePalette(); }

    /* ======================================================================
       DOCS-TOC — table of contents. A right-docked panel listing the doc's
       H1/H2 headings (nested), with live search, scroll-spy active-tracking,
       click-to-scroll, and collapsible H1 groups. Self-contained: a floating
       list-icon button toggles it. Opt out with opts.toc === false; drive it
       from a host icon via ed.toggleTOC()/openTOC()/closeTOC(). Styled by
       --mde-toc-* tokens (inherit the active theme). ===================== */
    const tocEnabled = opts.toc !== false;
    const tocButtonEnabled = opts.tocButton !== false;   // false => panel+API only, host drives it
    const TOC_ICON  = '<svg viewBox="0 0 24 24"><circle cx="5" cy="7" r="1.35"/><circle cx="5" cy="12" r="1.35"/><circle cx="5" cy="17" r="1.35"/><path d="M9.5 7h9.5M9.5 12h9.5M9.5 17h9.5"/></svg>';
    const TOC_CLOSE = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    const TOC_TWIST = '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';
    const TOC_FIND  = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.8 4.8"/></svg>';
    let tocRoot = null, tocBtn = null, tocPanel = null, tocList = null, tocSearch = null;
    let tocOpen = false, headings = [], tocActive = -1, tocRaf = 0, tocLock = 0;
    const tocCollapsed = new Set();   // keyed by H1 title — survives re-renders

    // Pull H1/H2 headings (in document order) straight from the rendered blocks;
    // each carries its live block element as the scroll target + clean title text.
    function collectHeadings() {
      const out = [];
      for (const b of blocks) {
        if (!b.el || !b.el.classList || !b.el.classList.contains("h")) continue;
        const lvl = b.el.classList.contains("h1") ? 1 : b.el.classList.contains("h2") ? 2 : 0;
        if (!lvl) continue;
        const raw = text.slice(b.s, b.e), m = raw.match(/^\s*#{1,6}\s+([\s\S]*)$/);
        const title = inlineToPlain(m ? m[1] : raw).trim() || "Untitled";
        out.push({ level: lvl, title, el: b.el });
      }
      return out;
    }

    function buildTocDom() {
      tocRoot = document.createElement("div"); tocRoot.className = "mde-toc-root";
      if (tocButtonEnabled) {
        tocBtn = document.createElement("button");
        tocBtn.type = "button"; tocBtn.className = "mde-toc-btn"; tocBtn.title = "Contents";
        tocBtn.setAttribute("aria-label", "Table of contents"); tocBtn.innerHTML = TOC_ICON;
        tocBtn.addEventListener("click", e => { e.preventDefault(); toggleTOC(); });
      }

      tocPanel = document.createElement("aside"); tocPanel.className = "mde-toc-panel";
      const head = document.createElement("div"); head.className = "mde-toc-head";
      const ttl = document.createElement("span"); ttl.className = "mde-toc-title"; ttl.textContent = "Contents";
      const x = document.createElement("button");
      x.type = "button"; x.className = "mde-toc-x"; x.setAttribute("aria-label", "Close"); x.innerHTML = TOC_CLOSE;
      x.addEventListener("click", e => { e.preventDefault(); closeTOC(); });
      head.appendChild(ttl); head.appendChild(x);

      const sw = document.createElement("div"); sw.className = "mde-toc-searchwrap"; sw.innerHTML = TOC_FIND;
      tocSearch = document.createElement("input");
      tocSearch.type = "text"; tocSearch.className = "mde-toc-search"; tocSearch.placeholder = "Search…";
      tocSearch.setAttribute("spellcheck", "false");
      tocSearch.addEventListener("input", renderTocList);
      tocSearch.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); if (tocSearch.value) { tocSearch.value = ""; renderTocList(); } else closeTOC(); } });
      sw.appendChild(tocSearch);

      tocList = document.createElement("div"); tocList.className = "mde-toc-list";
      tocPanel.appendChild(head); tocPanel.appendChild(sw); tocPanel.appendChild(tocList);
      if (tocBtn) tocRoot.appendChild(tocBtn);
      tocRoot.appendChild(tocPanel);
      document.body.appendChild(tocRoot);

      window.addEventListener("scroll", onTocReflow, true);
      window.addEventListener("resize", onTocReflow);
      placeTOC();
    }

    function onTocReflow() {
      if (tocRaf) return;
      tocRaf = requestAnimationFrame(() => { tocRaf = 0; placeTOC(); updateTocActive(); });
    }
    // Overlay the editor stage's VISIBLE band; button + panel dock within it.
    // Clamping to the viewport keeps the panel docked to the stage's right edge
    // yet always on-screen, whether the stage scrolls internally (the real apps)
    // or the whole window scrolls (the panel then pins to the visible band).
    function placeTOC() {
      if (!tocRoot || !stage) return;
      const r = stage.getBoundingClientRect();
      const top = Math.max(0, r.top), bottom = Math.min(window.innerHeight, r.bottom);
      tocRoot.style.left = r.left + "px"; tocRoot.style.width = r.width + "px";
      tocRoot.style.top = top + "px"; tocRoot.style.height = Math.max(0, bottom - top) + "px";
    }

    function renderTocList() {
      if (!tocList) return;
      const q = (tocSearch.value || "").trim().toLowerCase();
      const hit = h => !q || h.title.toLowerCase().indexOf(q) >= 0;
      tocList.innerHTML = "";
      if (!headings.length) { tocList.appendChild(emptyToc(q ? "No matches" : "No headings yet")); return; }
      // group H2s under the preceding H1
      const tree = []; let cur = null;
      headings.forEach((h, i) => {
        if (h.level === 1) { cur = { h, idx: i, kids: [] }; tree.push(cur); }
        else if (cur) cur.kids.push({ h, idx: i });
        else tree.push({ h, idx: i, kids: null });   // orphan H2 (no H1 above it)
      });
      let shown = 0;
      for (const node of tree) {
        if (!node.kids) { if (hit(node.h)) { tocList.appendChild(tocRow(node, 2, false)); shown++; } continue; }
        const kids = q ? node.kids.filter(k => hit(k.h)) : node.kids;
        if (q && !hit(node.h) && !kids.length) continue;
        const collapsed = !q && tocCollapsed.has(node.h.title);
        tocList.appendChild(tocRow(node, 1, node.kids.length > 0, collapsed));
        shown++;
        if (!collapsed && kids.length) {
          const wrap = document.createElement("div"); wrap.className = "mde-toc-children";
          kids.forEach(k => { wrap.appendChild(tocRow(k, 2, false)); shown++; });
          tocList.appendChild(wrap);
        }
      }
      if (!shown) tocList.appendChild(emptyToc("No matches"));
      markTocActive(tocActive);
    }
    function emptyToc(msg) { const d = document.createElement("div"); d.className = "mde-toc-empty"; d.textContent = msg; return d; }
    function tocRow(node, level, hasKids, collapsed) {
      const row = document.createElement("div"); row.className = "mde-toc-row lvl" + level;
      if (level === 1) {
        const tw = document.createElement("button");
        tw.type = "button"; tw.className = "mde-toc-twist" + (hasKids ? "" : " ghost") + (collapsed ? " collapsed" : "");
        tw.innerHTML = TOC_TWIST; tw.tabIndex = -1;
        if (hasKids) tw.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); if (tocCollapsed.has(node.h.title)) tocCollapsed.delete(node.h.title); else tocCollapsed.add(node.h.title); renderTocList(); });
        row.appendChild(tw);
      }
      const link = document.createElement("button");
      link.type = "button"; link.className = "mde-toc-link"; link.dataset.idx = node.idx;
      link.textContent = node.h.title;
      link.addEventListener("click", e => { e.preventDefault(); gotoHeading(node.idx); });
      row.appendChild(link);
      return row;
    }
    function gotoHeading(idx) {
      const h = headings[idx]; if (!h || !h.el) return;
      h.el.scrollIntoView({ behavior: "smooth", block: "start" });
      // a click wins over scroll-spy until the smooth scroll settles (a heading
      // near the doc end can't reach the top, so the fold would mis-highlight it)
      tocLock = performance.now() + 700; tocActive = idx; markTocActive(idx);
    }
    function markTocActive(idx) {
      if (!tocList) return;
      tocList.querySelectorAll(".mde-toc-link").forEach(el => el.classList.toggle("active", +el.dataset.idx === idx));
    }
    // is the active scroller (window or the internal stage) at its bottom?
    function tocAtBottom() {
      const d = document.documentElement;
      if (window.innerHeight + window.scrollY >= d.scrollHeight - 4) return true;
      if (stage && stage.scrollHeight - stage.clientHeight > 4 && stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 4) return true;
      return false;
    }
    // scroll-spy: the active heading is the last one at/above the stage top — but
    // at the very bottom the last heading wins (it may never reach the top), and a
    // recent click holds its target.
    function updateTocActive() {
      if (!tocOpen || !headings.length || !stage || performance.now() < tocLock) return;
      const top = stage.getBoundingClientRect().top + 64;
      let act = 0;
      for (let i = 0; i < headings.length; i++) {
        if (headings[i].el.getBoundingClientRect().top <= top) act = i; else break;
      }
      if (tocAtBottom()) act = headings.length - 1;
      if (act !== tocActive) { tocActive = act; markTocActive(act); }
    }
    function refreshTOC() { headings = collectHeadings(); renderTocList(); updateTocActive(); }

    function openTOC() {
      if (!tocEnabled) return;
      if (!tocRoot) buildTocDom();
      tocOpen = true; tocRoot.classList.add("open");
      placeTOC(); refreshTOC();
    }
    function closeTOC() { if (!tocOpen) return; tocOpen = false; if (tocRoot) tocRoot.classList.remove("open"); surface.focus(); }
    function toggleTOC() { tocOpen ? closeTOC() : openTOC(); }
    function isTOCOpen() { return tocOpen; }
    if (tocEnabled) { buildTocDom(); tocRefresh = function () { if (tocOpen) refreshTOC(); }; }

    /* ======================================================================
       DOCS-WC — word count. A passive "N words" pill at the editor stage's
       bottom-left (toggleable + persisted) plus a Google-Docs-style modal on
       Cmd/Ctrl+Shift+C with Words / Characters / Characters-excluding-spaces.
       SELECTION-AWARE (per-user): with no highlight the pill/modal report the
       FULL doc; while THIS user has text highlighted they report the highlighted
       portion only ("N words selected" / a "Selection" modal subtitle), reverting
       the instant the selection collapses. Each collaborator sees their own count.
       EVERY count runs on the CLEANED text — markdown marks, list bullets &
       numbers, %%comments%%, <!--comments-->, @{…} chips→labels, and @{s:…}
       style spans are all stripped — so HIDDEN FORMATTING never inflates the
       numbers. Opt out with opts.wordCount === false. Styled by --mde-* tokens
       (the body-mounted pill/modal inherit the active theme via <html>). ====== */
    const wcEnabled = opts.wordCount !== false;
    let wcRoot = null, wcPill = null, wcModal = null, wcScrim = null, wcCheck = null;
    let wcPlaceRaf = 0, wcCountRaf = 0;
    function wcLoadVisible() { try { const v = localStorage.getItem("mde-wc-pill"); return v === null ? true : v === "1"; } catch (_) { return true; } }
    let wcVisible = wcLoadVisible();
    function wcSaveVisible(v) { try { localStorage.setItem("mde-wc-pill", v ? "1" : "0"); } catch (_) {} }

    // Clean text for counting. Mirrors rangeToPlain but ALSO drops list bullets/
    // numbers and structural lines (rules, blanks) — Google Docs excludes those
    // from its counts too. Reuses the same renderer primitives, so chips, styles,
    // and comments are handled identically to the clean copy-out path.
    function wcPlain(src) {
      const lines = (src == null ? text : src).split("\n"), out = []; let i = 0;
      const hidden = commentLines(lines);
      while (i < lines.length) {
        if (hidden[i]) { i++; continue; }                    // <!--…--> comment block — never counted
        const tr = tableRunEnd(lines, i);
        if (tr) {
          const [hdr, j] = tr;
          out.push(splitCells(lines[hdr]).map(inlineToPlain).join(" "));
          for (let k = hdr + 2; k < j; k++) out.push(splitCells(lines[k]).map(inlineToPlain).join(" "));
          i = j; continue;
        }
        const ln = lines[i], b = classify(ln, 0, ln.length);
        if (b.type === "meta" || b.type === "hr" || b.type === "blank") { i++; continue; }   // %%…%% / --- / empty
        // headings/quotes/bullets/numbers: keep the CONTENT, drop the marker prefix
        out.push(inlineToPlain((b.type === "h" || b.type === "bq" || b.type === "li" || b.type === "ol") ? ln.slice(b.mlen) : ln));
        i++;
      }
      return out.join("\n");
    }
    // No args → whole doc. With a non-empty [from,to) source range → count only that
    // slice (the highlighted-portion count). Same cleaning either way, so a selection's
    // markdown marks / chips / comments / style spans never inflate the number.
    function wcCounts(from, to) {
      const ranged = from != null && to != null && from !== to;
      const p = ranged ? wcPlain(text.slice(Math.min(from, to), Math.max(from, to))) : wcPlain();
      const words = (p.match(/\S+/g) || []).length;        // runs of non-whitespace
      const chars = p.replace(/\n/g, "").length;           // chars incl. spaces; newlines (paragraph breaks) not counted
      const charsNoSpaces = p.replace(/\s/g, "").length;   // strip every whitespace
      return { words: words, chars: chars, charsNoSpaces: charsNoSpaces };
    }
    function wcFmt(n) { try { return n.toLocaleString(); } catch (_) { return String(n); } }

    function buildWcDom() {
      wcRoot = document.createElement("div"); wcRoot.className = "mde-wc-root";
      wcPill = document.createElement("button");
      wcPill.type = "button"; wcPill.className = "mde-wc-pill";
      wcPill.title = "Word count (" + (navigator.platform && /Mac/.test(navigator.platform) ? "⇧⌘C" : "Ctrl+Shift+C") + ")";
      wcPill.setAttribute("aria-label", "Word count");
      wcPill.addEventListener("click", function (e) { e.preventDefault(); openWordCount(); });
      wcRoot.appendChild(wcPill);
      document.body.appendChild(wcRoot);
      window.addEventListener("scroll", onWcReflow, true);
      window.addEventListener("resize", onWcReflow);
      placeWc(); updateWordCount();
    }
    function onWcReflow() { if (wcPlaceRaf) return; wcPlaceRaf = requestAnimationFrame(function () { wcPlaceRaf = 0; placeWc(); }); }
    // Overlay the stage's VISIBLE band (same approach as the TOC root) so the pill
    // pins to the bottom-left of the editing area whether the stage scrolls
    // internally or the whole window scrolls.
    function placeWc() {
      if (!wcRoot || !stage) return;
      const r = stage.getBoundingClientRect();
      const top = Math.max(0, r.top), bottom = Math.min(window.innerHeight, r.bottom);
      wcRoot.style.left = r.left + "px"; wcRoot.style.width = r.width + "px";
      wcRoot.style.top = top + "px"; wcRoot.style.height = Math.max(0, bottom - top) + "px";
    }
    function updateWordCount() {
      if (!wcPill) return;
      // Per-user, local selection: when this user has a highlight, the pill shows the
      // word count of the highlighted portion only; with no highlight it shows the full
      // doc. (Each collaborator reads their OWN selection, so the pill is inherently per-user.)
      const sel = selA !== selB;
      const n = (sel ? wcCounts(selA, selB) : wcCounts()).words;
      wcPill.textContent = wcFmt(n) + (n === 1 ? " word" : " words") + (sel ? " selected" : "");
      wcPill.classList.toggle("sel", sel);
      wcPill.classList.toggle("hidden", !wcVisible);
    }
    // Coalesce per-keystroke renders into one recompute per frame.
    function scheduleWcCount() { if (wcCountRaf) return; wcCountRaf = requestAnimationFrame(function () { wcCountRaf = 0; updateWordCount(); }); }

    function buildWcModal() {
      wcScrim = document.createElement("div"); wcScrim.className = "mde-wcmodal-scrim";
      wcModal = document.createElement("div"); wcModal.className = "mde-wcmodal";
      wcModal.setAttribute("role", "dialog"); wcModal.setAttribute("aria-modal", "true"); wcModal.setAttribute("aria-label", "Word count");
      wcModal.innerHTML =
        '<div class="mde-wc-h">Word Count<span class="mde-wc-sub" data-wc-sub></span></div>' +
        '<div class="mde-wc-rows">' +
          '<div class="mde-wc-row"><span class="mde-wc-k">Words</span><span class="mde-wc-v" data-wc="words">0</span></div>' +
          '<div class="mde-wc-row"><span class="mde-wc-k">Characters</span><span class="mde-wc-v" data-wc="chars">0</span></div>' +
          '<div class="mde-wc-row"><span class="mde-wc-k">Characters excluding spaces</span><span class="mde-wc-v" data-wc="charsNoSpaces">0</span></div>' +
        '</div>' +
        '<label class="mde-wc-toggle"><input type="checkbox" class="mde-wc-cb"><span>Display word count while typing</span></label>' +
        '<div class="mde-wc-actions"><button type="button" class="mde-wc-cancel">Cancel</button><button type="button" class="mde-wc-ok">OK</button></div>';
      wcCheck = wcModal.querySelector(".mde-wc-cb");
      wcModal.querySelector(".mde-wc-cancel").addEventListener("click", function (e) { e.preventDefault(); closeWordCount(false); });
      wcModal.querySelector(".mde-wc-ok").addEventListener("click", function (e) { e.preventDefault(); closeWordCount(true); });
      wcScrim.addEventListener("mousedown", function (e) { if (e.target === wcScrim) { e.preventDefault(); closeWordCount(false); } });
      wcScrim.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { e.preventDefault(); closeWordCount(false); }
        else if (e.key === "Enter") { e.preventDefault(); closeWordCount(true); }
      });
      wcScrim.appendChild(wcModal);
      document.body.appendChild(wcScrim);
    }
    function openWordCount() {
      if (!wcEnabled) return;
      if (!wcModal) buildWcModal();
      // Mirror the pill: with a highlight, the modal reports the selection's counts.
      const sel = selA !== selB;
      const c = sel ? wcCounts(selA, selB) : wcCounts();
      wcModal.querySelector('[data-wc="words"]').textContent = wcFmt(c.words);
      wcModal.querySelector('[data-wc="chars"]').textContent = wcFmt(c.chars);
      wcModal.querySelector('[data-wc="charsNoSpaces"]').textContent = wcFmt(c.charsNoSpaces);
      const sub = wcModal.querySelector('[data-wc-sub]'); if (sub) sub.textContent = sel ? "Selection" : "";
      wcCheck.checked = wcVisible;
      wcScrim.classList.add("open");
      const ok = wcModal.querySelector(".mde-wc-ok"); if (ok && ok.focus) ok.focus();
    }
    function closeWordCount(commit) {
      if (!wcScrim) return;
      if (commit) { wcVisible = !!wcCheck.checked; wcSaveVisible(wcVisible); updateWordCount(); }
      wcScrim.classList.remove("open");
      surface.focus();
    }
    if (wcEnabled) { buildWcDom(); wcRefresh = scheduleWcCount; wcCaretRefresh = scheduleWcCount; }

    /* A small whitelisted command API so a HOST TOOLBAR can run the essential
       editing actions (the same internals the palette drives). Keeps formatting
       logic in one place; the host just paints buttons and calls ed.cmd("bold"). */
    function cmd(name) {
      switch (name) {
        case "bold":    return wrap("**");
        case "italic":  return wrap("*");
        case "strike":  return wrap("~~");
        case "code":    return wrap("`");
        case "h1":      return setHeading(1);
        case "h2":      return setHeading(2);
        case "h3":      return setHeading(3);
        case "bullets": return togglePrefix(/^(\s*)[-*+]\s+/, "- ");
        case "numbers": return togglePrefix(/^(\s*)\d+\.\s+/, "1. ");
        case "quote":   return togglePrefix(/^(\s*)>\s?/, "> ");
        case "link":    return insertLink();
        case "rule":    return insertRule();
        case "table":   { const s = readSel() || [selA, selB]; return openGrid(s[0], s[1]); }
        case "clearfmt":return clearStyle();
        case "acceptmd":return setAcceptMarkdown(!acceptMd);
        case "undo":    return doUndo();
        case "redo":    return doRedo();
      }
    }

    return {
      setText(v) { dismiss(); text = (v == null ? "" : String(v)).replace(/\r\n?/g, "\n"); undo = []; redo = []; lastType = null; selA = selB = 0; render(); notifyReseed(); },
      getText() { return text; },
      focus() { surface.focus(); },
      caretToEnd() { setCaret(text.length); },
      dismiss,
      // DOCS-9 clean export — serialize the current selection (or the whole doc) to
      // human-clean output, no markdown / chip / style syntax. Useful for a "copy clean"
      // host button or an export pipeline.
      getClean(opts) { const o = opts || {}; const a = (o.selection && selA !== selB) ? selA : 0, b = (o.selection && selA !== selB) ? selB : text.length; const md = text.slice(a, b); return o.html ? rangeToHtml(md) : rangeToPlain(md); },
      // DOCS-4 / DOCS-8 — open the command palette, or apply/clear invisible styling
      // programmatically (e.g. from a host toolbar button).
      openPalette, applyStyle, clearStyle,
      // DOCS-6 — theme control: "dark" | "light" | "auto".
      setTheme, getTheme, toggleTheme,
      // DOCS-TOC — table of contents (H1/H2). Hide the built-in button with opts.tocButton:false
      // and drive it from a host toolbar via these.
      toggleTOC, openTOC, closeTOC, isTOCOpen, refreshTOC,
      // Fade the floating TOC button + word-count pill out of the way (e.g. while a host
      // overlay/drawer covers the editor) — they live on body-mounted roots the host can't reach.
      setTocButtonHidden(b) { if (tocRoot) tocRoot.classList.toggle("rail-open", !!b); if (wcRoot) wcRoot.classList.toggle("rail-open", !!b); },
      // DOCS-WC — word count over the CLEANED text (no markdown/chips/comments/styles).
      // openWordCount() shows the modal; wordCount() returns {words, chars, charsNoSpaces}
      // for the whole doc, or wordCount(from,to) for a source sub-range (the pill uses this
      // for the live highlighted-portion count);
      // setWordCountVisible() toggles the passive bottom-left pill (persists the choice).
      openWordCount, wordCount: wcCounts,
      setWordCountVisible(v) { wcVisible = !!v; wcSaveVisible(wcVisible); updateWordCount(); },
      // Whitelisted editing commands for a host toolbar (bold/italic/headings/lists/link/table/
      // undo/redo/…). The same internals the command palette uses.
      cmd,
      // Markdown demotion — per-user "accept markdown" easter-egg toggle (persisted). On (default):
      // typed emphasis marks flash once then hide and never reveal on click; off: raw marks stay
      // visible. Headers are unaffected. A host settings UI can drive these.
      getAcceptMarkdown, setAcceptMarkdown,
      toggleAcceptMarkdown() { setAcceptMarkdown(!acceptMd); },
      /* ---- Stage-2 collaboration hooks (additive; backend-agnostic) ----
         A host wires these from md-editor-collab.js (window.MarkdownCollab). Each is inert
         until used, so a non-collab host is byte-for-byte unaffected (Stage-1 suite stays green).
           onChange(cb)            → cb() AFTER every local mutation (not during applyRemote); returns unsubscribe
           onCaret(cb)             → cb(selA, selB) on local caret/selection change; returns unsubscribe
           onReseed(cb)            → cb() AFTER a host setText() re-baselines the doc; returns unsubscribe.
                                     A binding uses this to reset its `last` (so a stray setText — e.g. a tab
                                     switch — can't clobber the shared doc). NOTE: setText replaces the
                                     editor with DIFFERENT content; for true multi-tab collab the host must
                                     destroy() + bindCollab() to the new tab's Y.Text — onReseed only keeps a
                                     single binding from corrupting its current doc, it does not retarget it.
           applyRemote(i,del,ins)  → apply a remote splice (no echo); rebases the caret
           setRemoteCarets(list)   → draw remote cursors [{id,name,color,a,b}] ([] tears them down)
           setUndoHandler(u,r)     → route Cmd-Z/Y to a CRDT history (null,null restores the built-in) */
      onChange(cb) { if (typeof cb !== "function") return function () {}; changeListeners.push(cb); return function () { const i = changeListeners.indexOf(cb); if (i >= 0) changeListeners.splice(i, 1); }; },
      onCaret(cb) { if (typeof cb !== "function") return function () {}; caretListeners.push(cb); return function () { const i = caretListeners.indexOf(cb); if (i >= 0) caretListeners.splice(i, 1); }; },
      onReseed(cb) { if (typeof cb !== "function") return function () {}; reseedListeners.push(cb); return function () { const i = reseedListeners.indexOf(cb); if (i >= 0) reseedListeners.splice(i, 1); }; },
      applyRemote, setRemoteCarets,
      setUndoHandler(u, r) { extUndo = (typeof u === "function") ? u : null; extRedo = (typeof r === "function") ? r : null; },
      getSelection() { return [selA, selB]; },
    };
  }

  /* ======================================================================
     MarkdownTabs — a project-agnostic tabbed-document wrapper around makeEditor.
     One editor surface; switching a tab swaps the markdown in/out. Tab IDS ARE
     OPAQUE STRINGS supplied by the host — this widget holds NO identity, sync, or
     persistence logic (the host owns those via the hooks below). Styled by
     --mde-tab-* tokens.

     LAYOUT: tabs are a COLLAPSIBLE LEFT RAIL (panel icon toggles it; state persists
     in localStorage `mde-tabs-collapsed`), separated from the editor by a hairline.

       makeTabs(container, {
         tabs:[{id,title,emoji?,dim?,deletable?}], activeId?, people?, emptyLabel?,
         railTitle?,       // sidebar header label (default "Tabs")
         toc?, tocButton?, // forwarded to makeEditor (TOC panel + floating button)
         tabMenu?,         // set false to hide the per-tab ⋮ options menu
         loadTab(id) -> markdown (string|Promise),   // REQUIRED to show content
         onTabInput(id),   // content changed — host debounces + saves getText()
         onTabSave(id),    // Cmd/Ctrl-S — host flushes
         onSelect(prevId,nextId),  // before switching — host flushes prev
         onRename(id,title),       // inline rename committed
         onAddTab() -> {id,title,emoji?} | Promise | null,  // host creates the tab
         onReorder(orderedIds),    // drag-reorder committed — ids in their new order
         onDelete(id) -> bool|Promise,   // host deletes; return false to veto removal
         // Delete shows per-tab only when onDelete is set AND tab.deletable !== false
         // (default shown). onAddTab/onDuplicate results may carry deletable too.
         onDuplicate(id) -> {id,title?,emoji?} | Promise,  // host clones; a NEW id is required
         onSetEmoji(id, emoji),    // emoji chosen ("" clears it) — host persists
         linkForTab(id) -> url (string|Promise),   // override the "Copy link" target
       })
     Tab IDS ARE STABLE, OPAQUE SLUGS owned by the host: reorder/rename/emoji never
     change them — only onAddTab / onDuplicate mint new ones. The kebab (⋮) menu shows
     only the actions whose hooks are supplied (Copy link is always available).
     Instance: setTabs(list,selectId?) · addTab(t,select?) · renameTab(id,title) ·
       setEmoji(id,emoji) · getTabs() · selectTab(id) · getActiveId() · getText() ·
       setText(v) · getEditor() · focus()
     ====================================================================== */
  function makeTabs(container, opts) {
    opts = opts || {};
    const loadTab = opts.loadTab || function () { return ""; };
    const tabsState = [];       // [{ id, title, emoji, dim }] — id is the host's stable slug
    let activeId = null, loading = false, renaming = null;
    const tabMenuEnabled = opts.tabMenu !== false;

    const TABS_PANEL_ICON = '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/></svg>';
    const TABS_PLUS_ICON  = '<svg viewBox="0 0 24 24"><path d="M12 5.5v13M5.5 12h13"/></svg>';
    const TAB_KEBAB_ICON  = '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>';
    const MENU_ICONS = {
      rename:    '<svg viewBox="0 0 24 24"><path d="M4 20.5h4l9.5-9.5a2.1 2.1 0 0 0-3-3L5 17.5v3z"/><path d="M13 7l3 3"/></svg>',
      emoji:     '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M8.7 14.3a4 4 0 0 0 6.6 0M9 9.8h.01M15 9.8h.01"/></svg>',
      duplicate: '<svg viewBox="0 0 24 24"><rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M5.5 15.5H5A1.5 1.5 0 0 1 3.5 14V5A1.5 1.5 0 0 1 5 3.5h9A1.5 1.5 0 0 1 15.5 5v.5"/></svg>',
      link:      '<svg viewBox="0 0 24 24"><path d="M9.5 14.5l5-5"/><path d="M8 11 6 13a3.6 3.6 0 0 0 5 5l2-2"/><path d="M16 13l2-2a3.6 3.6 0 0 0-5-5l-2 2"/></svg>',
      trash:     '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M6.6 7l.8 12.4a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.4 7"/></svg>',
    };
    const TAB_EMOJIS = ["📄","📝","📌","⭐","✅","🔥","💡","🎯","🚀","📚","✏️","🗒️","📋","🧠","💬","🎓","🏫","🏆","❤️","👋","🤯","🍔","🌱","🌟","🔖","📎","🗂️","📁","🔬","🎨","⚡","🧩","☀️","🌙","🧭","✨"];
    function loadCollapsed() { try { return localStorage.getItem("mde-tabs-collapsed") === "1"; } catch (_) { return false; } }
    let collapsed = loadCollapsed();
    // on a narrow surface the rail is an overlay drawer (see the @container rule) — start
    // it closed so the editor is full-width; matchMedia here just avoids a first-paint flash.
    try { if (window.matchMedia && window.matchMedia("(max-width: 600px)").matches) collapsed = true; } catch (_) {}

    container.classList.add("mde-tabs");
    container.innerHTML = "";
    // ---- left rail: a header (collapse + title + add) over a vertical tab list ----
    const rail = document.createElement("div"); rail.className = "mde-tabrail";
    const railHead = document.createElement("div"); railHead.className = "mde-tabrail-head";
    const collapseBtn = document.createElement("button");
    collapseBtn.type = "button"; collapseBtn.className = "mde-tab-collapse"; collapseBtn.title = "Collapse";
    collapseBtn.setAttribute("aria-label", "Collapse tabs"); collapseBtn.innerHTML = TABS_PANEL_ICON;
    collapseBtn.addEventListener("click", () => setCollapsed(true));
    const railTitle = document.createElement("span"); railTitle.className = "mde-tabrail-title"; railTitle.textContent = opts.railTitle || "Tabs";
    railHead.appendChild(collapseBtn); railHead.appendChild(railTitle);
    if (opts.onAddTab) {
      const add = document.createElement("button");
      add.type = "button"; add.className = "mde-tab-add"; add.title = "New document";
      add.setAttribute("aria-label", "Add tab"); add.innerHTML = TABS_PLUS_ICON;
      add.addEventListener("click", addViaHost);
      railHead.appendChild(add);
    }
    const railList = document.createElement("div"); railList.className = "mde-tab-list";
    rail.appendChild(railHead); rail.appendChild(railList);

    // a reveal handle, shown only when the rail is collapsed
    const reveal = document.createElement("button");
    reveal.type = "button"; reveal.className = "mde-tab-reveal"; reveal.title = "Show tabs";
    reveal.setAttribute("aria-label", "Show tabs"); reveal.innerHTML = TABS_PANEL_ICON;
    reveal.addEventListener("click", () => setCollapsed(false));

    const stage = document.createElement("div"); stage.className = "editor-stage mde-tab-stage";
    const surface = document.createElement("div"); surface.className = "md-surface";
    // makeEditor doesn't make its surface editable — the host owns that. The tabs
    // wrapper creates the surface, so it sets it here (a host can flip it off for
    // a read-only view).
    surface.setAttribute("contenteditable", "true");
    surface.setAttribute("spellcheck", "true");
    stage.appendChild(surface);
    container.appendChild(rail);
    container.appendChild(reveal);
    container.appendChild(stage);
    // mobile overlay-drawer backdrop — inert/hidden on desktop, shown via the @container rule
    const scrim = document.createElement("div"); scrim.className = "mde-tab-scrim";
    scrim.addEventListener("click", () => setCollapsed(true));
    container.appendChild(scrim);
    container.classList.toggle("railcollapsed", collapsed);

    const ed = makeEditor(surface, {
      people: opts.people || [],
      toc: opts.toc,
      tocButton: opts.tocButton,
      acceptMarkdown: opts.acceptMarkdown,   // forward the markdown-demotion toggle (else the editor reads its persisted per-user pref)
      scrollParent: stage,
      onInput: function () { if (!loading && opts.onTabInput) opts.onTabInput(activeId); },
      onSave:  function () { if (opts.onTabSave) opts.onTabSave(activeId); },
    });

    // collapsing/expanding changes the stage width — nudge any body-mounted
    // overlays (the TOC panel tracks the stage rect) to reposition.
    function setCollapsed(v) {
      collapsed = v;
      container.classList.toggle("railcollapsed", v);
      // In narrow (drawer) mode, fade the floating TOC button while the drawer is open
      // so it doesn't glow over the scrim; restore it once the drawer closes.
      if (ed && ed.setTocButtonHidden) ed.setTocButtonHidden(container.classList.contains("mde-narrow") && !v);
      // on a narrow surface the drawer is transient — don't overwrite the desktop preference
      if (!container.classList.contains("mde-narrow")) { try { localStorage.setItem("mde-tabs-collapsed", v ? "1" : "0"); } catch (_) {} }
      window.dispatchEvent(new Event("resize"));
    }
    rail.addEventListener("transitionend", e => { if (e.propertyName === "flex-basis" || e.propertyName === "width" || e.propertyName === "transform") window.dispatchEvent(new Event("resize")); });
    // Track when the editor is narrow enough to switch the rail to an overlay drawer.
    // Keyed off the editor's OWN width (matches the @container rule), so it's correct even
    // when embedded in a narrow column on a wide screen.
    let wasNarrow = null;
    function syncNarrow() {
      const narrow = container.getBoundingClientRect().width <= 600;
      if (narrow === wasNarrow) return;
      wasNarrow = narrow;
      container.classList.toggle("mde-narrow", narrow);
      setCollapsed(narrow ? true : loadCollapsed());   // mobile → closed drawer; desktop → restore saved pref
    }
    if (typeof ResizeObserver !== "undefined") { const ro = new ResizeObserver(syncNarrow); ro.observe(container); }
    requestAnimationFrame(syncNarrow);

    function renderRail() {
      closeTabMenu(); closeEmojiPop();
      railList.innerHTML = "";
      for (const t of tabsState) {
        const el = document.createElement("div");
        el.className = "mde-tab" + (t.id === activeId ? " active" : "") + (t.dim ? " dim" : "");
        el.dataset.id = t.id; el.title = t.title || "Untitled";
        el.setAttribute("role", "button"); el.tabIndex = 0;
        if (opts.onReorder) el.draggable = true;

        const emo = document.createElement("span");
        emo.className = "mde-tab-emoji";
        if (t.emoji) emo.textContent = t.emoji; else emo.style.display = "none";
        el.appendChild(emo);

        const label = document.createElement("span");
        label.className = "mde-tab-label";
        label.textContent = t.title || "Untitled";
        el.appendChild(label);

        if (tabMenuEnabled) {
          const kebab = document.createElement("button");
          kebab.type = "button"; kebab.className = "mde-tab-kebab";
          kebab.title = "Tab options"; kebab.setAttribute("aria-label", "Tab options");
          kebab.innerHTML = TAB_KEBAB_ICON;
          kebab.addEventListener("mousedown", e => e.stopPropagation());
          kebab.addEventListener("click", e => { e.stopPropagation(); openTabMenu(t, kebab); });
          el.appendChild(kebab);
        }

        el.addEventListener("click", function () { if (!renaming) selectTab(t.id); });
        el.addEventListener("keydown", function (e) {
          if ((e.key === "Enter" || e.key === " ") && !renaming) { e.preventDefault(); selectTab(t.id); }
        });
        if (opts.onRename)
          el.addEventListener("dblclick", function (e) { e.preventDefault(); beginRename(t, label); });
        if (opts.onReorder) wireDrag(el, t);
        railList.appendChild(el);
      }
      if (!tabsState.length) {
        const empty = document.createElement("div");
        empty.className = "mde-tab-empty";
        empty.textContent = opts.emptyLabel || "No documents yet";
        railList.appendChild(empty);
      }
    }

    async function selectTab(id) {
      if (id === activeId) { ed.focus(); return; }
      const prev = activeId;
      if (opts.onSelect) { try { await opts.onSelect(prev, id); } catch (e) {} }
      activeId = id;
      renderRail();
      loading = true;
      let md = "";
      try { md = await loadTab(id); } catch (e) {}
      ed.setText(md == null ? "" : md);
      loading = false;
      const activeEl = rail.querySelector(".mde-tab.active");
      if (activeEl && activeEl.scrollIntoView) activeEl.scrollIntoView({ block: "nearest", inline: "nearest" });
      if (container.classList.contains("mde-narrow")) setCollapsed(true);   // mobile: close the drawer after picking
      ed.focus();
    }

    function beginRename(t, labelEl) {
      renaming = t.id;
      const row = labelEl.closest(".mde-tab");
      if (row) row.draggable = false;   // don't let a text-selection drag the tab
      closeTabMenu(); closeEmojiPop();
      labelEl.contentEditable = "true";
      labelEl.spellcheck = false;
      labelEl.focus();
      const r = document.createRange(); r.selectNodeContents(labelEl);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      function commit(save) {
        labelEl.contentEditable = "false";
        if (row && opts.onReorder) row.draggable = true;
        renaming = null;
        const next = labelEl.textContent.trim();
        if (save && next && next !== t.title) {
          t.title = next; labelEl.textContent = next;
          if (opts.onRename) opts.onRename(t.id, next);
        } else { labelEl.textContent = t.title; }
      }
      labelEl.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); labelEl.blur(); }
        else if (e.key === "Escape") { e.preventDefault(); labelEl.textContent = t.title; labelEl.blur(); }
      });
      labelEl.addEventListener("blur", function () { commit(true); }, { once: true });
    }

    async function addViaHost() {
      if (!opts.onAddTab) return;
      let res;
      try { res = await opts.onAddTab(); } catch (e) { return; }
      if (!res || !res.id) return;
      tabsState.push({ id: res.id, title: res.title || "Untitled", emoji: res.emoji || "", dim: false, deletable: res.deletable !== false });
      renderRail();
      selectTab(res.id);
    }

    /* ---- per-tab ⋮ menu, emoji picker, drag-reorder, copy-link ---------------
       All owned by this widget; identity stays with the host's opaque ids. The
       menu + picker are body-mounted (like the palette) — --mde-* tokens live on
       :root so they still theme. Toast lives in the stage. ----------------------*/
    const tabMenu  = document.createElement("div"); tabMenu.className  = "mde-tab-menu";  document.body.appendChild(tabMenu);
    const emojiPop = document.createElement("div"); emojiPop.className = "mde-emoji-pop"; document.body.appendChild(emojiPop);
    const toast    = document.createElement("div"); toast.className    = "mde-tab-toast"; container.appendChild(toast);
    let toastTimer = null, dragId = null;

    function rowFor(id) { return Array.prototype.find.call(railList.children, el => el.dataset && el.dataset.id === id); }
    function closeTabMenu() { tabMenu.classList.remove("open"); const k = railList.querySelector(".mde-tab-kebab.open"); if (k) k.classList.remove("open"); }
    function closeEmojiPop() { emojiPop.classList.remove("open"); }
    function anyPopOpen() { return tabMenu.classList.contains("open") || emojiPop.classList.contains("open"); }
    function positionPop(pop, anchor) {
      pop.style.visibility = "hidden"; pop.style.left = "0"; pop.style.top = "0";
      const r = anchor.getBoundingClientRect(), pr = pop.getBoundingClientRect(), M = 8;
      let left = r.right - pr.width, top = r.bottom + 4;
      if (left + pr.width > window.innerWidth - M) left = window.innerWidth - M - pr.width;
      if (left < M) left = M;
      if (top + pr.height > window.innerHeight - M) top = r.top - pr.height - 4;
      if (top < M) top = M;
      pop.style.left = left + "px"; pop.style.top = top + "px"; pop.style.visibility = "";
    }
    function menuItem(text, icon, onClick, danger) {
      const it = document.createElement("button");
      it.type = "button"; it.className = "mde-tab-menu-item" + (danger ? " danger" : "");
      const wrap = document.createElement("span"); wrap.innerHTML = icon; it.appendChild(wrap.firstChild);
      const sp = document.createElement("span"); sp.textContent = text; it.appendChild(sp);
      it.addEventListener("click", e => { e.stopPropagation(); onClick(); });
      return it;
    }
    function openTabMenu(t, anchor) {
      const reopen = tabMenu.classList.contains("open") && tabMenu.dataset.for === t.id;
      closeEmojiPop(); closeTabMenu();
      if (reopen) return;
      tabMenu.innerHTML = ""; tabMenu.dataset.for = t.id;
      if (opts.onRename)    tabMenu.appendChild(menuItem("Rename", MENU_ICONS.rename, () => { closeTabMenu(); startRename(t); }));
      if (opts.onSetEmoji)  tabMenu.appendChild(menuItem("Choose emoji", MENU_ICONS.emoji, () => openEmojiPop(t, anchor)));
      if (opts.onDuplicate) tabMenu.appendChild(menuItem("Duplicate", MENU_ICONS.duplicate, () => { closeTabMenu(); duplicateTab(t); }));
      tabMenu.appendChild(menuItem("Copy link", MENU_ICONS.link, () => { closeTabMenu(); copyLink(t); }));
      // Delete shows only when the host supplies onDelete AND this tab opts in
      // (t.deletable !== false) — so a host can hide it per-tab. Default: shown.
      if (opts.onDelete && t.deletable !== false) {
        const sep = document.createElement("div"); sep.className = "mde-tab-menu-sep"; tabMenu.appendChild(sep);
        tabMenu.appendChild(menuItem("Delete", MENU_ICONS.trash, () => { closeTabMenu(); deleteTab(t); }, true));
      }
      tabMenu.classList.add("open"); anchor.classList.add("open");
      positionPop(tabMenu, anchor);
    }
    function openEmojiPop(t, anchor) {
      closeTabMenu();
      emojiPop.innerHTML = "";
      const grid = document.createElement("div"); grid.className = "mde-emoji-grid";
      TAB_EMOJIS.forEach(e => {
        const c = document.createElement("button"); c.type = "button"; c.className = "mde-emoji-cell"; c.textContent = e;
        c.addEventListener("click", ev => { ev.stopPropagation(); setEmoji(t, e); closeEmojiPop(); });
        grid.appendChild(c);
      });
      emojiPop.appendChild(grid);
      if (t.emoji) {
        const none = document.createElement("button"); none.type = "button"; none.className = "mde-emoji-none"; none.textContent = "Remove emoji";
        none.addEventListener("click", ev => { ev.stopPropagation(); setEmoji(t, ""); closeEmojiPop(); });
        emojiPop.appendChild(none);
      }
      emojiPop.classList.add("open");
      positionPop(emojiPop, anchor);
    }
    function setEmoji(t, emoji) {
      t.emoji = emoji || ""; renderRail();
      if (opts.onSetEmoji) try { opts.onSetEmoji(t.id, t.emoji); } catch (_) {}
    }
    function startRename(t) { const row = rowFor(t.id); const label = row && row.querySelector(".mde-tab-label"); if (label) beginRename(t, label); }
    async function duplicateTab(t) {
      if (!opts.onDuplicate) return;
      let res; try { res = await opts.onDuplicate(t.id); } catch (_) { return; }
      if (!res || !res.id) return;
      const idx = tabsState.findIndex(x => x.id === t.id);
      const nt = { id: res.id, title: res.title || ((t.title || "Untitled") + " copy"),
                   emoji: res.emoji != null ? res.emoji : (t.emoji || ""), dim: false,
                   deletable: res.deletable !== false };
      tabsState.splice(idx < 0 ? tabsState.length : idx + 1, 0, nt);
      renderRail(); selectTab(nt.id);
    }
    async function deleteTab(t) {
      if (!opts.onDelete) return;
      if (!window.confirm('Delete "' + (t.title || "Untitled") + '"? This can\'t be undone.')) return;
      try { if ((await opts.onDelete(t.id)) === false) return; } catch (_) { return; }
      const idx = tabsState.findIndex(x => x.id === t.id);
      if (idx < 0) return;
      tabsState.splice(idx, 1);
      if (activeId === t.id) {
        activeId = null;
        const next = tabsState[idx] || tabsState[idx - 1];
        renderRail();
        if (next) selectTab(next.id); else { loading = true; ed.setText(""); loading = false; }
      } else renderRail();
    }
    async function copyLink(t) {
      let url = null;
      if (opts.linkForTab) { try { url = await opts.linkForTab(t.id); } catch (_) {} }
      if (!url) { try { const u = new URL(window.location.href); u.searchParams.set("tab", t.id); url = u.toString(); } catch (_) { url = t.id; } }
      let ok = false;
      try { await navigator.clipboard.writeText(url); ok = true; }
      catch (_) {
        try {
          const ta = document.createElement("textarea"); ta.value = url; ta.style.position = "fixed"; ta.style.opacity = "0";
          document.body.appendChild(ta); ta.focus(); ta.select(); ok = document.execCommand("copy"); document.body.removeChild(ta);
        } catch (_2) {}
      }
      flashToast(ok ? "Link copied" : "Couldn’t copy link");
    }
    function flashToast(msg) {
      toast.textContent = msg; toast.classList.add("show");
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove("show"), 1500);
    }

    // ---- drag-to-reorder (HTML5 DnD); only order changes, ids are preserved ----
    function clearDropMarkers() { railList.querySelectorAll(".drop-before,.drop-after").forEach(el => el.classList.remove("drop-before", "drop-after")); }
    function dropBefore(e, el) { const r = el.getBoundingClientRect(); return (e.clientY - r.top) < r.height / 2; }
    function wireDrag(el, t) {
      el.addEventListener("dragstart", e => {
        if (renaming) { e.preventDefault(); return; }
        dragId = t.id; el.classList.add("dragging"); closeTabMenu(); closeEmojiPop();
        try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", t.id); } catch (_) {}
      });
      el.addEventListener("dragend", () => { el.classList.remove("dragging"); clearDropMarkers(); dragId = null; });
      el.addEventListener("dragover", e => {
        if (dragId == null || t.id === dragId) return;
        e.preventDefault(); try { e.dataTransfer.dropEffect = "move"; } catch (_) {}
        const before = dropBefore(e, el); clearDropMarkers();
        el.classList.add(before ? "drop-before" : "drop-after");
      });
      el.addEventListener("dragleave", () => el.classList.remove("drop-before", "drop-after"));
      el.addEventListener("drop", e => {
        e.preventDefault();
        if (dragId == null || t.id === dragId) { clearDropMarkers(); return; }
        const before = dropBefore(e, el); clearDropMarkers(); moveTab(dragId, t.id, before);
      });
    }
    function moveTab(srcId, targetId, before) {
      const from = tabsState.findIndex(x => x.id === srcId); if (from < 0) return;
      const [item] = tabsState.splice(from, 1);
      let to = tabsState.findIndex(x => x.id === targetId);
      if (to < 0) { tabsState.splice(from, 0, item); return; }
      if (!before) to += 1;
      tabsState.splice(to, 0, item);
      renderRail();
      if (opts.onReorder) try { opts.onReorder(tabsState.map(x => x.id)); } catch (_) {}
    }

    // close popups on outside click / Escape / scroll / resize
    document.addEventListener("mousedown", e => {
      if (!anyPopOpen()) return;
      if (tabMenu.contains(e.target) || emojiPop.contains(e.target)) return;
      if (e.target.closest && e.target.closest(".mde-tab-kebab")) return;
      closeTabMenu(); closeEmojiPop();
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && anyPopOpen()) { closeTabMenu(); closeEmojiPop(); } });
    window.addEventListener("resize", () => { closeTabMenu(); closeEmojiPop(); });
    window.addEventListener("scroll", () => { closeTabMenu(); closeEmojiPop(); }, true);

    const api = {
      setTabs(list, selectId) {
        tabsState.length = 0;
        for (const t of (list || [])) tabsState.push({ id: t.id, title: t.title || "Untitled", emoji: t.emoji || "", dim: !!t.dim, deletable: t.deletable !== false });
        activeId = null;
        renderRail();
        const first = selectId || (tabsState[0] && tabsState[0].id);
        if (first) selectTab(first); else { loading = true; ed.setText(""); loading = false; }
      },
      addTab(t, select) {
        tabsState.push({ id: t.id, title: t.title || "Untitled", emoji: t.emoji || "", dim: !!t.dim, deletable: t.deletable !== false });
        renderRail();
        if (select !== false) selectTab(t.id);
      },
      renameTab(id, title) { const t = tabsState.find(x => x.id === id); if (t) { t.title = title; renderRail(); } },
      setEmoji(id, emoji) { const t = tabsState.find(x => x.id === id); if (t) { t.emoji = emoji || ""; renderRail(); } },
      getTabs() { return tabsState.map(t => ({ id: t.id, title: t.title, emoji: t.emoji, dim: t.dim, deletable: t.deletable })); },
      selectTab,
      getActiveId() { return activeId; },
      getText() { return ed.getText(); },
      setText(v) { loading = true; ed.setText(v); loading = false; },
      getEditor() { return ed; },
      focus() { ed.focus(); },
      // markdown-demotion toggle — delegated to the inner editor so a host settings UI can drive it
      getAcceptMarkdown() { return ed.getAcceptMarkdown(); },
      setAcceptMarkdown(v) { return ed.setAcceptMarkdown(v); },
      toggleAcceptMarkdown() { return ed.toggleAcceptMarkdown(); },
      // Stage-2 collaboration hooks — delegated to the active tab's editor. A collab binding is
      // strictly PER ACTIVE TAB and does NOT survive a tab switch: selectTab/setText re-seed the
      // SAME editor with a DIFFERENT tab's content, so a binding bound to getEditor() (or to tabs)
      // now points at the wrong document. The host MUST destroy() the old binding and bindCollab()
      // to the newly-active tab's Y.Text on every tab change. (As a safety net, the binding listens
      // for onReseed and resets its baseline so a stray setText can't clobber its current shared
      // doc — but that does NOT retarget it; only destroy()+rebind does.)
      onChange(cb) { return ed.onChange(cb); },
      onCaret(cb) { return ed.onCaret(cb); },
      onReseed(cb) { return ed.onReseed(cb); },
      applyRemote(i, del, ins) { return ed.applyRemote(i, del, ins); },
      setRemoteCarets(list) { return ed.setRemoteCarets(list); },
      setUndoHandler(u, r) { return ed.setUndoHandler(u, r); },
      getSelection() { return ed.getSelection(); },
    };
    renderRail();
    if (opts.tabs) api.setTabs(opts.tabs, opts.activeId);
    return api;
  }

  /* Expose for "files" consumers that load this as a standalone <script>.
     Harmless when inline-injected into a host IIFE (just sets a global). */
  if (typeof window !== "undefined") {
    window.MarkdownEditor = makeEditor;
    window.MarkdownTabs = makeTabs;
  }
