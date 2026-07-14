/* ============================================================================
   md-editor.js — project-agnostic live-markdown editor (vanilla, no deps).
   `text` is the single source of truth; the DOM is a pure projection of it.
   API:  const ed = makeEditor(surface, opts)
     opts.onInput()      call (debounce it) after every content change
     opts.onSave()       called on Cmd/Ctrl-S
     opts.people         [{ name, email, accent?, accentBg?, accentBorder? }]
     opts.atCommands     [{ name, label?, sub?, group?, svg?, run }] — host actions on the "@"
                         menu. Hidden on a bare "@": an entry appears only once the typed query
                         is a ≥2-char prefix of its name (easter-egg discovery, e.g. "@bu…" →
                         Buddy). Committing consumes the typed "@query" via the normal edit()
                         path (undo-safe, fires onInput) and calls run(). Inert when omitted.
     opts.scrollParent   element whose scroll dismisses popovers (optional)
     opts.acceptMarkdown bool — typed markdown marks (**, *, `, ~~, #, >) are interpreted but
                         NEVER rendered (Word feel: syntax is an input method, not UI);
                         formatting is toggled via ⌘B/I/U, the toolbar, or the palette.
                         off ⇒ raw marks stay visible (classic markdown). Default on; persisted.
     ed.setText(v) / ed.getText() / ed.focus() / ed.caretToEnd() / ed.dismiss()
   See README.md for the %%comment%% syntax, tables, and Supabase wiring.
   ============================================================================ */

  /* ---- version stamp — the "@ver" easter egg (below, in the "@" menu) reads these two
     constants so any synced consumer can report exactly what it's running, with no central
     dashboard. THIS is the one real source of truth: it ships byte-for-byte with the file via
     sync.sh, so a consumer's own copy always answers for itself. Workflow: bump BOTH of these
     AND add a dated entry to CHANGELOG.md as a normal part of shipping any user-visible change —
     see CHANGELOG.md's header. Do not let this drift; a stale stamp defeats the whole feature. */
  const MDE_VERSION = "1.1.1";
  const MDE_LAST_CHANGE = "toolbar:true now docks the tab-reveal handle + headings/TOC button stacked together on the left below the bar (Google-Docs-style), instead of opposite top corners.";

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
    // host-registered @ commands (see header) — validated once; malformed entries are dropped
    const ATCMDS = Array.isArray(opts.atCommands)
      ? opts.atCommands.filter(c => c && typeof c.name === "string" && c.name && typeof c.run === "function")
      : [];
    const scrollParent = opts.scrollParent || null;
    // images: a host can route inserted files somewhere real (returns a src string/Promise)
    // and map relative srcs in the doc to fetchable URLs (e.g. the desktop app's file server).
    const imageUpload = opts.imageUpload || null;
    const resolveImg = opts.resolveImageSrc || (s => s);
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
    let barRefresh = null;     // TOOLBAR: set when opts.toolbar is on; re-reads caretFormats() after caret/selection changes
    // Markdown demotion: when acceptMd is on, emphasis marks (**, *, `, ~~) render but NEVER
    // show — not on caret entry, not on creation (Word/Docs feel: the syntax is an input
    // method, never a visible artifact). Formatting is added/removed via toggles (Cmd-B/I/U,
    // toolbar, palette), which unwrap the hidden markers in the source. Headers stay on the
    // separate block path. acceptMd off ⇒ raw marks stay shown (classic md).
    let acceptMd = (typeof opts.acceptMarkdown === "boolean") ? opts.acceptMarkdown : loadAcceptMd();

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
        if (c === "!" && content[i + 1] === "[") {
          const cb = content.indexOf("]", i + 2);
          if (cb > i && content[cb + 1] === "(") {
            const cp = content.indexOf(")", cb + 2);
            if (cp > cb) {
              pushText(i);
              // an adjacent %%img:…%% comment carries this image's render instructions
              // (size / alignment / text wrap) — same convention as the table %%cols%% line
              let e = cp + 1, spec = null;
              const m = /^%%img:([^%]*)%%/.exec(content.slice(cp + 1));
              if (m) { spec = m[1]; e += m[0].length; }
              out.push({ kind: "img", s: base + i, e: base + e, alt: content.slice(i + 2, cb), url: content.slice(cb + 2, cp), spec });
              i = e; ts = i; continue;
            }
          }
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
      if ((m = ln.match(/^(\s*[-*+]\s+\[( |x|X)\]\s+)(.*)$/))) return { type: "task", checked: m[2] !== " ", mlen: m[1].length, s, e, raw: ln };
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
        if (t.kind === "img") {
          // one atomic island (like a chip): the raw ![alt](src)%%img:…%% source is never
          // shown; the <img> renders with its %%img spec (width % / align / text wrap)
          const fig = document.createElement("span");
          fig.className = "mimg";
          fig.setAttribute("contenteditable", "false");
          fig.dataset.s = t.s; fig.dataset.len = t.e - t.s;
          const o = parseImgSpec(t.spec);
          if (o.wrap && (o.align === "left" || o.align === "right")) fig.classList.add("wrap-" + o.align);
          else if (o.align) fig.classList.add("al-" + o.align);
          if (o.w != null) fig.style.width = o.w + "%";
          const img = document.createElement("img");
          const src = safeImgSrc(t.url);
          if (src) img.src = resolveImg(src);
          img.alt = t.alt || ""; img.draggable = false;
          fig.appendChild(img);
          fig.addEventListener("mousedown", ev => { ev.preventDefault(); decorateImg(fig); });
          leaves.push({ el: fig, s: t.s, len: t.e - t.s, atomic: true });
          parent.appendChild(fig); continue;
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
    // Task 2 (restart numbering): an ordered item's SOURCE digit is markdown-native
    // signal, not just decoration — normally it's ignored (numbers auto-renumber
    // sequentially by position, like bullets do), but when a line's source digit
    // doesn't match the expected next value at its depth (most commonly a "1." typed
    // after a higher-numbered run), that digit is honored as an explicit RESTART: the
    // count jumps to it instead of continuing. Consecutive lists (where each source
    // digit already matches its expected position — the normal case, since Enter-to-
    // continue writes the correct next digit) render exactly as before.
    function computeListMarkers(lines, hidden) {
      const out = new Array(lines.length).fill(null), counts = [];
      for (let k = 0; k < lines.length; k++) {
        if (hidden[k]) continue;            // no-render comment block — leave counters as-is
        const ln = lines[k]; let mm, type = null, depth = 0;
        if ((mm = ln.match(/^( *)([-*+])\s+/)))      { type = "ul"; depth = Math.floor(mm[1].length / LIST_INDENT); }
        else if ((mm = ln.match(/^( *)(\d+)\.\s+/))) { type = "ol"; depth = Math.floor(mm[1].length / LIST_INDENT); }
        if (!type) { if (ln.trim() !== "") counts.length = 0; continue; }   // blanks keep the list alive
        counts.length = depth + 1;          // drop deeper counters (restart on re-descent)
        if (type === "ol") {
          const expected = (counts[depth] || 0) + 1, srcNum = parseInt(mm[2], 10);
          counts[depth] = (srcNum === expected) ? expected : srcNum;   // mismatch ⇒ explicit restart
          out[k] = { depth, marker: listMarker("ol", counts[depth], depth) };
        }
        else { counts[depth] = 0; out[k] = { depth, marker: listMarker("ul", 0, depth) }; }   // a bullet breaks the ordered run at its depth
      }
      return out;
    }
    function render() {
      suppress = true;
      surface.textContent = "";
      leaves = []; blocks = []; toks = [];
      const lines = text.split("\n");
      applyDocVars(lines);   // document-level styles ride a hidden %%doc:…%% line
      const starts = []; { let o = 0; for (let k = 0; k < lines.length; k++) { starts.push(o); o += lines[k].length + 1; } }
      const hidden = commentLines(lines);
      // the %%doc:…%% styles line is machine-managed (the Document-styles dialog) —
      // never render or peek it; it collapses like a <!--…--> block (atomic island)
      for (let k = 0; k < lines.length; k++) if (DOC_LINE_RE.test(lines[k]) || IND_LINE_RE.test(lines[k])) hidden[k] = true;
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
        div.className = "ln " + ({ h: "h h" + b.lvl, bq: "bq", li: "li", ol: "ol", task: "li task", hr: "hr", blank: "blank", p: "p", meta: "meta" }[b.type] || "p");
        blocks.push({ el: div, s: b.s, e: b.e });
        if (b.type === "h" || b.type === "bq") {
          // acceptMd (Word feel): the "# "/"> " prefix is a hidden ATOMIC leaf — it never
          // shows, and backspace at content start removes the whole prefix (de-formats).
          // Classic mode keeps the caret-reveal .blockmk behavior.
          if (acceptMd) div.appendChild(listMarkerLeaf(b.raw.slice(0, b.mlen), b.s));
          else div.appendChild(leafSpan(b.raw.slice(0, b.mlen), b.s, "blockmk"));
          const hBody = b.raw.slice(b.mlen);
          if (hBody === "") {
            const sp = leafSpan("", b.s + b.mlen, "seg");
            sp.appendChild(document.createElement("br"));
            div.appendChild(sp);
          } else {
            appendInline(div, hBody, b.s + b.mlen);
          }
        } else if (b.type === "task") {
          // checklist item: the raw "- [ ] " source is a hidden atomic leaf; a real
          // clickable checkbox is drawn in its place and toggles the [ ]/[x] in source
          const info = listInfo[i] || { depth: 0 };
          if (b.checked) div.classList.add("done");
          div.style.setProperty("--li-depth", info.depth);
          div.appendChild(listMarkerLeaf(b.raw.slice(0, b.mlen), b.s));
          const cb = document.createElement("button");
          cb.type = "button"; cb.className = "tcb"; cb.setAttribute("contenteditable", "false");
          cb.tabIndex = -1; cb.setAttribute("aria-label", b.checked ? "Mark incomplete" : "Mark complete");
          const bs = b.s, bm = b.mlen;
          cb.addEventListener("mousedown", ev => { ev.preventDefault(); ev.stopPropagation(); toggleTask(bs, bm); });
          div.appendChild(cb);
          const tBody = b.raw.slice(b.mlen);
          if (tBody === "") {
            const sp = leafSpan("", b.s + b.mlen, "seg");
            sp.appendChild(document.createElement("br"));
            div.appendChild(sp);
          } else {
            appendInline(div, tBody, b.s + b.mlen);
          }
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
          if (b.type === "p" && i > 0) {
            const lvl = indLevelOf(lines[i - 1]);
            if (lvl) div.style.setProperty("--p-indent", (lvl * 3) + "em");
          }
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
          // demoted for good: emphasis marks NEVER show when acceptMd is on (no flash, no
          // caret-reveal) — Word/Docs feel. When off, raw marks stay shown (classic md).
          on = !acceptMd;
        } else {
          on = selA <= t.e && selB >= t.s;   // links / comments keep caret-reveal
        }
        t.el.classList.toggle("on", on);
      }
      if (barRefresh) barRefresh();   // keep toolbar button states in sync with the caret
    }
    /* ----- markdown demotion: per-user accept-markdown ----- */
    function isEmphTok(el) {
      const c = el.classList;
      return c.contains("b") || c.contains("em") || c.contains("del") || c.contains("code");
    }
    function loadAcceptMd() { try { const v = localStorage.getItem("mde-accept-md"); return v == null ? true : v === "1"; } catch (_) { return true; } }
    function getAcceptMarkdown() { return acceptMd; }
    function setAcceptMarkdown(v) {
      acceptMd = !!v;
      try { localStorage.setItem("mde-accept-md", acceptMd ? "1" : "0"); } catch (_) {}
      // re-resolve the caret when focused, so toggling to "hidden" can't strand it inside a now-invisible mark
      if (document.activeElement === surface) setCaret(selA, selB); else applyReveal();
    }

    /* =====================================================================
       Word-feel emphasis engine. The markdown marks are an implementation
       detail the user never sees (acceptMd): toggles below add/remove the
       hidden markers; deletions treat a marker pair as one unit so a ranged
       delete can never strand an orphan `**` that would render as raw text.
       ===================================================================== */
    const EMPH_MARKS = { b: ["**", "__"], em: ["*", "_"], del: ["~~", "~~"], code: ["`", "`"] };
    // live emphasis tokens (from the rendered toks) with marker + inner ranges
    function emphTokens() {
      const out = [];
      for (const t of toks) {
        const c = t.el.classList;
        const kind = c.contains("b") ? "b" : c.contains("em") ? "em" : c.contains("del") ? "del" : c.contains("code") ? "code" : null;
        if (!kind) continue;
        const mlen = (kind === "b" || kind === "del") ? 2 : 1;
        out.push({ kind, mlen, s: t.s, e: t.e, is: t.s + mlen, ie: t.e - mlen });
      }
      return out;
    }
    // Never let an edit boundary sit INSIDE a (hidden) 2-char marker: snap outward.
    function snapMarks(a, b) {
      for (const t of emphTokens()) {
        if (a > t.s && a < t.is) a = t.s;
        if (b > t.s && b < t.is) b = t.is;
        if (a > t.ie && a < t.e) a = t.ie;
        if (b > t.ie && b < t.e) b = t.e;
      }
      return [a, b];
    }
    // Ranged deletes treat marker pairs as units: snap half-cut markers whole, and when a
    // delete removes exactly ONE marker of a pair, delete the surviving partner too — so the
    // source can never hold an orphan mark that would suddenly render as raw syntax.
    function balanceEmphasis(a, b) {
      const s = snapMarks(a, b); a = s[0]; b = s[1];
      const extra = [];
      for (const t of emphTokens()) {
        const openIn = t.s >= a && t.is <= b;
        const closeIn = t.ie >= a && t.e <= b;
        if (openIn && !closeIn) extra.push([t.ie, t.e]);
        else if (closeIn && !openIn) extra.push([t.s, t.is]);
      }
      return { a, b, extra };
    }
    // Backspace/forward-delete hop over hidden marker runs so they act on the char the
    // user SEES next to the caret (Word: formatting boundaries are invisible to delete).
    function skipMarksLeft(p) {
      if (!acceptMd) return p;
      let moved = true;
      while (moved) {
        moved = false;
        for (const t of emphTokens()) {
          if (t.e === p && t.ie < t.e) { p = t.ie; moved = true; break; }
          if (t.is === p && t.s < t.is) { p = t.s; moved = true; break; }
        }
      }
      return p;
    }
    function skipMarksRight(p) {
      if (!acceptMd) return p;
      let moved = true;
      while (moved) {
        moved = false;
        for (const t of emphTokens()) {
          if (t.s === p && t.s < t.is) { p = t.is; moved = true; break; }
          if (t.ie === p && t.ie < t.e) { p = t.e; moved = true; break; }
        }
      }
      return p;
    }
    // After a delete, an emphasis pair whose inner emptied out (`****`, ` `` `) is garbage the
    // user can't see or reach — and a lone `****` line would even re-classify as a horizontal
    // rule. Scan at TEXT level (parseInline per line, independent of how the block classified)
    // and remove every empty pair. Returns the rebased caret.
    function sweepEmptyEmph(car) {
      if (!acceptMd) return car;
      let removed = false, changed = true;
      while (changed) {
        changed = false;
        let off = 0;
        for (const ln of text.split("\n")) {
          for (const t of parseInline(ln, off)) {
            if ((t.kind === "strong" || t.kind === "em" || t.kind === "del" || t.kind === "code") && t.inner === "") {
              text = text.slice(0, t.s) + text.slice(t.e);
              if (car > t.e) car -= t.e - t.s; else if (car > t.s) car = t.s;
              changed = removed = true; break;
            }
          }
          if (changed) break;
          off += ln.length + 1;
        }
      }
      if (removed) render();
      return car;
    }
    // Per-line editable segments of [a,b): emphasis is a per-line construct, so toggles
    // apply line by line — each segment excludes the block prefix and trims whitespace.
    function lineSegments(a, b) {
      const segs = [];
      let ls = lineStart(a);
      while (ls <= b) {
        let le = text.indexOf("\n", ls); if (le < 0) le = text.length;
        const bl = classify(text.slice(ls, le), ls, le);
        const cs = ls + (bl.mlen || 0);
        let sa = Math.max(a, cs), sb = Math.min(b, le);
        while (sa < sb && /\s/.test(text[sa])) sa++;
        while (sb > sa && /\s/.test(text[sb - 1])) sb--;
        if (sa < sb) segs.push([sa, sb]);
        if (le >= b || le >= text.length) break;
        ls = le + 1;
      }
      return segs;
    }
    // is [a,b) fully covered by tokens of `kind`? (markers count as covered — they're invisible)
    function segCovered(info, a, b) {
      let pos = a;
      const cover = info.filter(t => t.e > a && t.s < b).sort((x, y) => x.s - y.s);
      for (const t of cover) {
        if (t.s > pos) return false;
        if (t.e > pos) pos = t.e;
      }
      return pos >= b;
    }
    function shiftPoint(pos, at, delta, insAt) {
      // rebase a caret point across one splice; insAt: an insert AT pos lands before it
      if (pos > at || (pos === at && insAt)) return pos + delta;
      return pos;
    }
    // The one entry point for Bold / Italic / Strike / Code — true Word semantics:
    //   collapsed caret inside a run  → unwrap that whole run
    //   collapsed caret in a word     → format/unformat the word
    //   selection fully formatted     → remove formatting (splitting runs as needed)
    //   selection partly formatted    → extend formatting across the whole selection
    function toggleInline(kind) {
      const cur = readSel() || [selA, selB];
      let a = cur[0], b = cur[1];
      const snapped = snapMarks(a, b); a = snapped[0]; b = snapped[1];
      const mine = () => emphTokens().filter(t => t.kind === kind);
      if (a === b) {
        const t = mine().find(t => t.s <= a && a <= t.e);
        if (t) {
          // Word/Docs "terminate formatting, keep typing": on a NON-empty run, a caret at the
          // trailing content edge (where it lands right after you type the last formatted char)
          // hops PAST the closing mark so the next char is plain; the leading edge hops before
          // the opening mark. Empty pair / strictly-inside → remove the run (unchanged).
          if (t.is !== t.ie) {
            if (a === t.ie) { setCaret(t.e); return; }
            if (a === t.is) { setCaret(t.s); return; }
          }
          unwrapEmph(t, a); return;
        }
        const w = wordRangeAt(a);
        // no word at the caret (e.g. an empty line): nothing to wrap. An empty pair (`****`) has
        // no inner content, so the parser can't recognize/hide it as a real emphasis run — it would
        // just sit there as bare, permanently-visible asterisks. No-op instead.
        if (w[0] === w[1]) return;
        const ws = snapMarks(w[0], w[1]); a = ws[0]; b = ws[1];
      }
      const segs = lineSegments(a, b);
      if (!segs.length) return;
      const allOn = segs.every(sg => segCovered(mine(), sg[0], sg[1]));
      snapshot("wrap");
      // work bottom-up so earlier segment offsets stay valid
      let selLo = null, selHi = null;
      for (let i = segs.length - 1; i >= 0; i--) {
        const r = allOn ? removeInlineSeg(kind, segs[i][0], segs[i][1]) : addInlineSeg(kind, segs[i][0], segs[i][1]);
        if (i === segs.length - 1) selHi = r[1];
        selLo = r[0];
      }
      render(); setCaret(selLo, selHi); onInput();
    }
    function unwrapEmph(t, at) {
      snapshot("wrap");
      text = text.slice(0, t.ie) + text.slice(t.e);
      text = text.slice(0, t.s) + text.slice(t.is);
      const car = Math.max(t.s, Math.min((at == null ? t.ie : at) - t.mlen, t.ie - t.mlen));
      render(); setCaret(car); onInput();
    }
    function wordRangeAt(pos) {
      let wa = pos, wb = pos;
      while (wa > 0 && !/\s/.test(text[wa - 1])) wa--;
      while (wb < text.length && !/\s/.test(text[wb])) wb++;
      return [wa, wb];
    }
    // remove `kind` from [a,b) — splitting straddling runs; returns the new [a,b)
    function removeInlineSeg(kind, a, b) {
      const cover = emphTokens().filter(t => t.kind === kind && t.e > a && t.s < b).sort((x, y) => y.s - x.s);
      for (const t of cover) {
        const mk = text.slice(t.s, t.is);
        const preLen = Math.max(0, Math.min(a, t.ie) - t.is);    // formatted run left of the selection
        const postLen = Math.max(0, t.ie - Math.max(b, t.is));   // formatted run right of it
        // rebuild the token: [mk pre mk] gap [mk post mk] — degenerate parts drop out
        const inner = text.slice(t.is, t.ie);
        const cutA = Math.max(t.is, Math.min(a, t.ie)) - t.is, cutB = Math.max(t.is, Math.min(b, t.ie)) - t.is;
        const pre = inner.slice(0, cutA), mid = inner.slice(cutA, cutB), post = inner.slice(cutB);
        const repl = (preLen ? mk + pre + mk : pre) + mid + (postLen ? mk + post + mk : post);
        text = text.slice(0, t.s) + repl + text.slice(t.e);
        const delta = repl.length - (t.e - t.s);
        // rebase segment bounds across this token's rewrite
        const aIn = a > t.s ? a + (preLen ? mk.length : -mk.length) : a;
        const bIn = b < t.e ? b + (preLen ? mk.length : -mk.length) : b + delta;
        a = Math.max(0, aIn); b = Math.max(a, bIn);
      }
      return [a, b];
    }
    // add `kind` over [a,b) — swallowing/merging any same-kind runs it touches; returns new [a,b)
    function addInlineSeg(kind, a, b) {
      const touching = emphTokens().filter(t => t.kind === kind && t.e >= a && t.s <= b).sort((x, y) => y.s - x.s);
      let na = a, nb = b;
      for (const t of touching) { na = Math.min(na, t.s); nb = Math.max(nb, t.e); }
      for (const t of touching) {   // strip their markers (descending order)
        text = text.slice(0, t.ie) + text.slice(t.e);
        text = text.slice(0, t.s) + text.slice(t.is);
        nb -= 2 * t.mlen;
      }
      // pick the marker variant that can't collide with a neighbouring same-char mark
      let mk = EMPH_MARKS[kind][0];
      const ch = mk[0];
      if (EMPH_MARKS[kind][1] !== mk &&
          (text[na - 1] === ch || text[nb] === ch || text[na] === ch || text[nb - 1] === ch)) mk = EMPH_MARKS[kind][1];
      text = text.slice(0, nb) + mk + text.slice(nb);
      text = text.slice(0, na) + mk + text.slice(na);
      return [na + mk.length, nb + mk.length];
    }
    // formats active at the current selection (drives toolbar button states)
    function caretFormats() {
      let a = selA, b = selB;
      const out = { b: false, em: false, del: false, code: false, u: false, h: 0, li: false, ol: false, bq: false };
      const info = emphTokens();
      for (const kind of ["b", "em", "del", "code"]) {
        const mine = info.filter(t => t.kind === kind);
        if (a === b) out[kind] = !!mine.find(t => t.s < a && a < t.e);
        else out[kind] = lineSegments(a, b).length > 0 && lineSegments(a, b).every(sg => segCovered(mine, sg[0], sg[1]));
      }
      const sp = enclosingStyleSpan(a, b);
      if (sp && parseStyleSpec(text.slice(sp.s + 4, sp.openEnd - 1)).u === "1") out.u = true;
      const lr = curLineRange(a), bl = classify(text.slice(lr[0], lr[1]), lr[0], lr[1]);
      if (bl.type === "h") out.h = bl.lvl;
      out.li = bl.type === "li" || bl.type === "task"; out.ol = bl.type === "ol"; out.bq = bl.type === "bq";
      out.task = bl.type === "task";
      return out;
    }

    /* =====================================================================
       Images — ![alt](src) + an adjacent %%img:w=NN;align=…;wrap=1%% comment
       for render instructions (the %%cols%% convention). Click an image for
       a floating layout toolbar (align / text-wrap / delete) and a corner
       grip that drag-resizes it; everything commits back into the source.
       ===================================================================== */
    function parseImgSpec(spec) {
      const m = parseStyleSpec(spec || ""), out = {};
      const w = safeNum(m.w, 5, 100); if (w != null) out.w = Math.round(w * 10) / 10;
      if (m.align === "left" || m.align === "center" || m.align === "right") out.align = m.align;
      if (m.wrap === "1") out.wrap = true;
      return out;
    }
    function imgSpecStr(o) {
      const parts = [];
      if (o.w != null) parts.push("w=" + o.w);
      if (o.align) parts.push("align=" + o.align);
      if (o.wrap) parts.push("wrap=1");
      return parts.join(";");
    }
    function safeImgSrc(u) {
      u = String(u == null ? "" : u).trim();
      if (!u) return null;
      if (/^https?:\/\//i.test(u) || /^\/\//.test(u)) return u;
      if (/^data:image\//i.test(u)) return u;
      if (/^[a-z][a-z0-9+.\-]*:/i.test(u)) return null;   // every other scheme (javascript: etc.)
      return u;                                            // relative path — host resolves it
    }
    const IMG_ICONS = {
      alignL: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="9" height="9" rx="1.5"/><path d="M3.5 18h17M16 8h4.5M16 11h4.5"/></svg>',
      alignC: '<svg viewBox="0 0 24 24"><rect x="7.5" y="5" width="9" height="9" rx="1.5"/><path d="M3.5 18h17"/></svg>',
      alignR: '<svg viewBox="0 0 24 24"><rect x="11.5" y="5" width="9" height="9" rx="1.5"/><path d="M3.5 18h17M3.5 8H8M3.5 11H8"/></svg>',
      wrapL:  '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="8" height="8" rx="1.5"/><path d="M15 6.5h5.5M15 10h5.5M15 13.5h5.5M3.5 17h17M3.5 20.5h17"/></svg>',
      wrapR:  '<svg viewBox="0 0 24 24"><rect x="12.5" y="5" width="8" height="8" rx="1.5"/><path d="M3.5 6.5H9M3.5 10H9M3.5 13.5H9M3.5 17h17M3.5 20.5h17"/></svg>',
      inline: '<svg viewBox="0 0 24 24"><path d="M3.5 6.5h17M3.5 17.5h17M3.5 12h4"/><rect x="10" y="9.5" width="6" height="5" rx="1"/></svg>',
      trash:  '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M6.6 7l.8 12.4a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.4 7"/></svg>',
    };
    let imgSel = null;   // the currently-decorated .mimg element (cleared on re-render/outside click)
    function undecorateImg() {
      if (!imgSel) return;
      imgSel.classList.remove("sel");
      const t = imgSel.querySelector(".mimg-tools"); if (t) t.remove();
      const g = imgSel.querySelector(".mimg-grip"); if (g) g.remove();
      imgSel = null;
    }
    function imgParts(fig) {   // reparse this image's source slice
      const s = +fig.dataset.s, len = +fig.dataset.len;
      const m = /^!\[([^\]]*)\]\(([^)]*)\)(?:%%img:([^%]*)%%)?$/.exec(text.slice(s, s + len));
      return m ? { s, len, alt: m[1], url: m[2], o: parseImgSpec(m[3] || "") } : null;
    }
    function commitImg(fig, changes) {
      const p = imgParts(fig); if (!p) return;
      for (const k in changes) { if (changes[k] == null) delete p.o[k]; else p.o[k] = changes[k]; }
      const spec = imgSpecStr(p.o);
      const repl = "![" + p.alt + "](" + p.url + ")" + (spec ? "%%img:" + spec + "%%" : "");
      snapshot("img");
      text = text.slice(0, p.s) + repl + text.slice(p.s + p.len);
      render(); onInput();
      const nf = surface.querySelector('.mimg[data-s="' + p.s + '"]');
      if (nf) decorateImg(nf);
    }
    function decorateImg(fig) {
      if (imgSel === fig) return;
      undecorateImg();
      imgSel = fig;
      fig.classList.add("sel");
      setCaret(+fig.dataset.s, +fig.dataset.s + +fig.dataset.len);
      const p = imgParts(fig) || { o: {} };
      const bar = document.createElement("div"); bar.className = "mimg-tools"; bar.setAttribute("contenteditable", "false");
      const add = (ico, title, on, fn) => {
        const b = document.createElement("button");
        b.type = "button"; b.className = "mit" + (on ? " on" : ""); b.title = title; b.innerHTML = ico;
        b.addEventListener("mousedown", ev => { ev.preventDefault(); ev.stopPropagation(); fn(); });
        bar.appendChild(b);
      };
      const mode = p.o.wrap && (p.o.align === "left" || p.o.align === "right") ? "wrap-" + p.o.align : (p.o.align || "inline");
      add(IMG_ICONS.inline, "Inline with text", mode === "inline", () => commitImg(fig, { align: null, wrap: null }));
      add(IMG_ICONS.alignL, "Align left",  mode === "left",   () => commitImg(fig, { align: "left", wrap: null }));
      add(IMG_ICONS.alignC, "Center",      mode === "center", () => commitImg(fig, { align: "center", wrap: null }));
      add(IMG_ICONS.alignR, "Align right", mode === "right",  () => commitImg(fig, { align: "right", wrap: null }));
      add(IMG_ICONS.wrapL, "Wrap text (image left)",  mode === "wrap-left",  () => commitImg(fig, { align: "left", wrap: true }));
      add(IMG_ICONS.wrapR, "Wrap text (image right)", mode === "wrap-right", () => commitImg(fig, { align: "right", wrap: true }));
      const sep = document.createElement("span"); sep.className = "mit-sep"; bar.appendChild(sep);
      add(IMG_ICONS.trash, "Remove image", false, () => { const s = +fig.dataset.s, len = +fig.dataset.len; undecorateImg(); edit(s, s + len, "", s, "del"); });
      fig.appendChild(bar);
      const grip = document.createElement("div"); grip.className = "mimg-grip"; grip.setAttribute("contenteditable", "false");
      grip.addEventListener("pointerdown", e => {
        e.preventDefault(); e.stopPropagation();
        const baseW = surface.clientWidth || 1, left = fig.getBoundingClientRect().left;
        let pct = null;
        const onMove = ev => {
          pct = Math.max(5, Math.min(100, (ev.clientX - left) / baseW * 100));
          fig.style.width = pct + "%";
        };
        const onUp = () => {
          window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp);
          if (pct != null) commitImg(fig, { w: Math.round(pct * 10) / 10 });
        };
        window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
      });
      fig.appendChild(grip);
    }
    document.addEventListener("mousedown", e => {
      if (imgSel && !imgSel.contains(e.target)) undecorateImg();
    }, true);
    function insertImageSrc(src, name) {
      src = String(src == null ? "" : src).trim().replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
      if (!safeImgSrc(src)) return;
      const alt = String(name || "image").replace(/[\[\]()\n]/g, "").slice(0, 80);
      const c = readSel() || [selA, selB];
      const tok = "![" + alt + "](" + src + ")";
      edit(c[0], c[1], tok, c[0] + tok.length, "img");
    }
    async function insertImageFile(f) {
      if (!f || !/^image\//.test(f.type || "")) return;
      try {
        let src;
        if (imageUpload) src = await imageUpload(f);
        else src = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
        if (src) insertImageSrc(src, (f.name || "image").replace(/\.[a-z0-9]+$/i, ""));
      } catch (_) {}
    }
    function pickImage() {
      const inp = document.createElement("input");
      inp.type = "file"; inp.accept = "image/*"; inp.style.display = "none";
      document.body.appendChild(inp);
      inp.addEventListener("change", () => { const f = inp.files && inp.files[0]; inp.remove(); if (f) insertImageFile(f); });
      inp.click();
      setTimeout(() => { if (inp.parentNode) inp.remove(); }, 60000);
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
      // any ranged replace treats hidden emphasis-marker pairs as units (never orphans one)
      let extra = null;
      if (acceptMd && b > a) { const bal = balanceEmphasis(a, b); a = bal.a; b = bal.b; extra = bal.extra; }
      snapshot(type);
      let removedBefore = 0;
      if (extra && extra.length) {
        const segs = extra.map(sg => [sg[0], sg[1], false]).concat([[a, b, true]]).sort((x, y) => y[0] - x[0]);
        for (const sg of segs) {
          if (sg[2]) text = text.slice(0, a) + ins + text.slice(b);
          else { text = text.slice(0, sg[0]) + text.slice(sg[1]); if (sg[1] <= a) removedBefore += sg[1] - sg[0]; }
        }
      } else {
        text = text.slice(0, a) + ins + text.slice(b);
      }
      render();
      let car = (caret == null ? a + ins.length : caret) - removedBefore;
      if ((type === "del" || type === "cut") && !ins) car = sweepEmptyEmph(car);
      setCaret(Math.max(0, Math.min(car, text.length)));
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

    // checklist: flip the [ ]/[x] inside a task line's hidden marker
    function toggleTask(s, mlen) {
      const idx = text.indexOf("[", s);
      if (idx < 0 || idx >= s + mlen) return;
      const now = text[idx + 1];
      snapshot("task");
      text = text.slice(0, idx + 1) + (now === " " ? "x" : " ") + text.slice(idx + 2);
      render(); setCaret(selA, selB); onInput();
    }

    /* ----- smart lists: Enter continues a bullet/numbered/checklist item (next
       marker, numbers auto-increment); Enter on an EMPTY item exits the list.
       Returns true when it handled the keystroke, so the caller skips the plain newline. */
    function smartListEnter(pos) {
      const ls = lineStart(pos);
      let le = text.indexOf("\n", pos); if (le < 0) le = text.length;
      const line = text.slice(ls, le);
      let m, prefix;
      if ((m = line.match(/^( *)([-*+])\s+\[(?: |x|X)\]\s+(.*)$/))) {
        if (m[3].trim() === "") return emptyListItem(ls, le, m[1], "ul");
        prefix = m[1] + m[2] + " [ ] ";
        const ins = "\n" + prefix;
        edit(pos, pos, ins, pos + ins.length, "nl");
        return true;
      }
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
    // Task 2 support — what digit should a NEW/converted ordered-list line at `depth`,
    // sitting at source offset `ls` (a line start), continue from? Walks backward through
    // the same run computeListMarkers recognizes (blank lines and deeper nested items
    // don't break it; a same/shallower line does), so outdenting or toggling INTO a list
    // continues its numbering by default — instead of writing a hardcoded "1." that would
    // spuriously read as an explicit restart (Task 2's mismatch rule) once it lands after
    // a higher-numbered run at that depth.
    function nextOlDigit(ls, depth) {
      let p = ls;
      while (p > 0) {
        const ps = lineStart(p - 1);
        const ln = text.slice(ps, p - 1);
        if (ln.trim() === "") { p = ps; continue; }              // blank — keep looking back
        let mm;
        if ((mm = ln.match(/^( *)(\d+)\.\s+/))) {
          const d = Math.floor(mm[1].length / LIST_INDENT);
          if (d === depth) return parseInt(mm[2], 10) + 1;
          if (d < depth) return 1;                                // shallower ol — run doesn't reach back
          p = ps; continue;                                       // deeper ol — doesn't affect this depth
        }
        if ((mm = ln.match(/^( *)([-*+])\s+/))) {
          const d = Math.floor(mm[1].length / LIST_INDENT);
          if (d <= depth) return 1;                                // same/shallower bullet — run broken
          p = ps; continue;                                        // deeper bullet — doesn't affect this depth
        }
        return 1;                                                   // plain non-list line — run doesn't reach back
      }
      return 1;
    }
    // Word-style per-paragraph first-line indent: Tab/Shift+Tab at the very start of a plain
    // paragraph steps its hidden %%ind:N%% line (see IND_LINE_RE above) instead of the
    // document-wide default. Reads the (possibly absent) meta line directly above `ls`.
    function paraIndentLevel(ls) {
      if (ls === 0) return { level: 0, metaStart: -1, metaEnd: -1 };
      const prevStart = lineStart(ls - 1), prevLine = text.slice(prevStart, ls - 1);
      return IND_LINE_RE.test(prevLine) ? { level: indLevelOf(prevLine), metaStart: prevStart, metaEnd: ls } : { level: 0, metaStart: -1, metaEnd: -1 };
    }
    function adjustParaIndent(ls, delta) {
      const cur = paraIndentLevel(ls);
      const next = Math.max(0, Math.min(6, cur.level + delta));
      if (next === cur.level) return;
      snapshot("block");
      let car;
      if (cur.metaStart >= 0) {
        const repl = next === 0 ? "" : "%%ind:" + next + "%%\n";
        text = text.slice(0, cur.metaStart) + repl + text.slice(cur.metaEnd);
        car = cur.metaStart + repl.length;
      } else {
        const ins = "%%ind:" + next + "%%\n";
        text = text.slice(0, ls) + ins + text.slice(ls);
        car = ls + ins.length;
      }
      render(); setCaret(car); onInput();
    }
    // Enter on an EMPTY list item: outdent one level if nested, else exit the list (Docs/Word).
    function emptyListItem(ls, le, lead, type) {
      if (lead.length >= LIST_INDENT) {
        const depth = Math.floor((lead.length - LIST_INDENT) / LIST_INDENT);
        const marker = type === "ol" ? (nextOlDigit(ls, depth) + ". ") : "- ";
        const repl = lead.slice(LIST_INDENT) + marker;
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
      else if (t === "insertParagraph" || t === "insertLineBreak") {
        e.preventDefault();
        // collapsed caret resting just before a hidden closing marker (e.g. right after typing
        // "**word") must hop past it first — otherwise the \n splices BETWEEN content and its
        // closing mark, orphaning the mark alone on the next line ("**word" / "**").
        if (a === b) { const p = skipMarksRight(a); if (!smartListEnter(p)) edit(p, p, "\n", p + 1, "nl"); }
        else edit(a, b, "\n", a + 1, "nl");
      }
      else if (t === "deleteContentBackward") { e.preventDefault(); if (a !== b) edit(a, b, "", a, "del"); else { const sk = skipMarksLeft(a); if (sk > 0) { const ch = atomicBefore(sk); if (ch) edit(ch.s, sk, "", ch.s, "del"); else { const p = prevG(sk); edit(p, sk, "", p, "del"); } } } }
      else if (t === "deleteContentForward")  { e.preventDefault(); if (a !== b) edit(a, b, "", a, "del"); else { const sk = skipMarksRight(b); if (sk < text.length) { const ch = atomicAfter(sk); if (ch) edit(sk, ch.s + ch.len, "", a, "del"); else { const x = nextG(sk); edit(sk, x, "", a, "del"); } } } }
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
        else if (t.kind === "img") { /* images aren't text — drop from plain export/counts */ }
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
        else if (t.kind === "img") {
          const src = safeImgSrc(t.url), o = parseImgSpec(t.spec);
          if (src) out += '<img src="' + esc(src) + '" alt="' + esc(t.alt || "") + '"' + (o.w != null ? ' style="width:' + o.w + '%"' : "") + ">";
        }
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
        else if (b.type === "task") out.push((b.checked ? "☑ " : "☐ ") + inlineToPlain(ln.slice(b.mlen)));
        else if (b.type === "li") out.push("• " + inlineToPlain(ln.slice(b.mlen)));
        else if (b.type === "ol") { const m = ln.match(/^\s*(\d+)\./); out.push((m ? m[1] : "1") + ". " + inlineToPlain(ln.slice(b.mlen))); }
        else if (b.type === "blank") out.push("");
        else out.push(inlineToPlain(ln));
        i++;
      }
      return out.join("\n");
    }
    function rangeToHtml(md) {
      const lines = md.split("\n"); let html = "", i = 0, listType = null, buf = [], olCount = 0;
      const hidden = commentLines(lines);
      // Task 2 — olCount tracks the running number of the CURRENT flat <ol> block (this
      // export already flattens nesting, so restart-tracking is scoped the same way): a
      // source digit that doesn't match the expected next value gets an explicit
      // value="N" on that <li> — valid HTML5 that native rendering honors, then resumes
      // auto-numbering from N for the following unlabeled <li>s. Keeps getClean({html:true})
      // consistent with the editor's own rendering (computeListMarkers) for restarts.
      const flush = () => { if (listType) { html += "<" + listType + ">" + buf.join("") + "</" + listType + ">"; listType = null; buf = []; } olCount = 0; };
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
        if (b.type === "task") { if (listType !== "ul") { flush(); listType = "ul"; } buf.push("<li>" + (b.checked ? "☑ " : "☐ ") + inlineToHtml(ln.slice(b.mlen)) + "</li>"); i++; continue; }
        if (b.type === "li") { if (listType !== "ul") { flush(); listType = "ul"; } buf.push("<li>" + inlineToHtml(ln.slice(b.mlen)) + "</li>"); i++; continue; }
        if (b.type === "ol") {
          if (listType !== "ol") { flush(); listType = "ol"; }
          // this export flattens nesting (no nested <ol>s), so restart-tracking only
          // compares DEPTH-0 items against each other — an indented (nested) item never
          // triggers a restart and never advances olCount, so it can't make a LATER
          // depth-0 item's own (correct, depth-relative) digit look like a false restart.
          // It still gets its own native <li> and native browser auto-numbering, which —
          // left alone (no value=) — reproduces the pre-Task-2 flat sequential count.
          const dm = ln.match(/^( *)(\d+)\./), indented = !!(dm && dm[1].length > 0);
          let restart = false, val = olCount + 1;
          if (!indented) { const srcNum = dm ? parseInt(dm[2], 10) : val; restart = srcNum !== val; val = srcNum; }
          if (!indented) olCount = val;
          buf.push("<li" + (restart ? ' value="' + val + '"' : "") + ">" + inlineToHtml(ln.slice(b.mlen)) + "</li>");
          i++; continue;
        }
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
      if (!d && cd.files && cd.files.length && /^image\//.test(cd.files[0].type || "")) { insertImageFile(cd.files[0]); return; }   // pasted image (screenshot etc.)
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
      const fs = e.dataTransfer && e.dataTransfer.files;
      if (fs && fs.length && /^image\//.test(fs[0].type || "")) { e.preventDefault(); insertImageFile(fs[0]); return; }   // dropped image file
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
      if (mod && (e.key === "b" || e.key === "B")) { e.preventDefault(); toggleInline("b"); return; }
      if (mod && (e.key === "i" || e.key === "I")) { e.preventDefault(); toggleInline("em"); return; }
      if (mod && (e.key === "u" || e.key === "U")) { e.preventDefault(); toggleUnderline(); return; }
      if (mod && e.shiftKey && (e.key === "x" || e.key === "X")) { e.preventDefault(); toggleInline("del"); return; }
      if (mod && (e.key === "k" || e.key === "K")) { e.preventDefault(); insertLink(); return; }
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
        } else if (c[0] === c[1] && c[0] === lr[0]) {
          // Word-style: Tab/Shift+Tab with a collapsed caret at the very START of a plain
          // paragraph sets/steps that paragraph's first-line indent (0.5in/3em per step),
          // instead of inserting literal spaces — mid-line Tab below still inserts spaces.
          adjustParaIndent(lr[0], e.shiftKey ? -1 : 1);
        } else if (!e.shiftKey) { edit(c[0], c[1], "  ", c[0] + 2, "type"); }
        return;
      }
    });
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
    function specOf(sp) { return text.slice(sp.s + 4, sp.openEnd - 1); }
    // innermost style span whose INNER fully contains [a,b]
    function enclosingStyleSpan(a, b) {
      let target = null;
      for (const sp of scanStyleSpans(text))
        if (sp.openEnd <= a && sp.closeStart >= b && (!target || (sp.e - sp.s) < (target.e - target.s))) target = sp;
      return target;
    }
    function styleWrapStr(spec, inner) { return spec ? "@{s:" + spec + "}" + inner + "@{/s}" : inner; }
    // Apply props to ONE per-line range [a,b). Returns {a, b} of the styled inner afterwards.
    // exact span → merge specs; strictly-inside a span → SPLIT it (pre/mid/post); else wrap.
    function applyStyleSeg(a, b, props) {
      const exact = scanStyleSpans(text).find(sp => sp.openEnd === a && sp.closeStart === b);
      if (exact) {                                          // already wrapped → merge specs
        const cur = parseStyleSpec(specOf(exact));
        for (const k in props) { if (props[k] === null) delete cur[k]; else cur[k] = props[k]; }
        const spec = styleSpecToStr(cur);
        const repl = styleWrapStr(spec, text.slice(a, b));
        text = text.slice(0, exact.s) + repl + text.slice(exact.e);
        const openLen = spec ? spec.length + 5 : 0;
        return { a: exact.s + openLen, b: exact.s + openLen + (b - a) };
      }
      const host = enclosingStyleSpan(a, b);
      if (host) {                                           // inside a bigger span → split it
        const cur = parseStyleSpec(specOf(host));
        const mid = {}; for (const k in cur) mid[k] = cur[k];
        for (const k in props) { if (props[k] === null) delete mid[k]; else mid[k] = props[k]; }
        const curSpec = styleSpecToStr(cur), midSpec = styleSpecToStr(mid);
        const pre = text.slice(host.openEnd, a), sel = text.slice(a, b), post = text.slice(b, host.closeStart);
        const parts = [];
        if (pre) parts.push(styleWrapStr(curSpec, pre));
        const midAt = parts.join("").length;
        parts.push(styleWrapStr(midSpec, sel));
        if (post) parts.push(styleWrapStr(curSpec, post));
        text = text.slice(0, host.s) + parts.join("") + text.slice(host.e);
        const selAt = host.s + midAt + (midSpec ? midSpec.length + 5 : 0);
        return { a: selAt, b: selAt + sel.length };
      }
      const clean = {}; for (const k in props) if (props[k] != null && props[k] !== "") clean[k] = props[k];
      const spec = styleSpecToStr(clean); if (!spec) return { a, b };
      const open = "@{s:" + spec + "}", inner = text.slice(a, b);
      text = text.slice(0, a) + open + inner + "@{/s}" + text.slice(b);
      return { a: a + open.length, b: a + open.length + inner.length };
    }
    // wrap the current selection (or the word/styled run at the caret) in invisible styling;
    // multi-line selections style each line's content separately (spans are per-line).
    function applyStyle(props) {
      const c = readSel() || [selA, selB]; let a = c[0], b = c[1];
      if (a === b) {
        const host = enclosingStyleSpan(a, b);
        if (host) { a = host.openEnd; b = host.closeStart; }
        else { const w = wordRangeAt(a); a = w[0]; b = w[1]; }
        if (a === b) return;                                // nothing at the caret to style
      }
      const s2 = snapMarks(a, b); a = s2[0]; b = s2[1];
      const segs = lineSegments(a, b);
      if (!segs.length) return;
      snapshot("style");
      let lo = null, hi = null;
      for (let i = segs.length - 1; i >= 0; i--) {
        const r = applyStyleSeg(segs[i][0], segs[i][1], props);
        if (i === segs.length - 1) hi = r.b;
        lo = r.a;
      }
      render(); setCaret(lo, hi); onInput();  // keep inner selected so styles stack
    }
    // Cmd/Ctrl-U — underline on/off over the selection, the styled run, or the caret word
    function toggleUnderline() {
      const c = readSel() || [selA, selB]; let a = c[0], b = c[1];
      if (a === b) {
        const host = enclosingStyleSpan(a, b);
        if (host && parseStyleSpec(specOf(host)).u === "1") {
          // terminate underline and keep typing (mirrors toggleInline): on a NON-empty
          // underlined span, a caret at the trailing/leading content edge hops outside it.
          if (host.closeStart > host.openEnd) {
            if (a === host.closeStart) { setCaret(host.e); return; }
            if (a === host.openEnd)   { setCaret(host.s); return; }
          }
          applyStyle({ u: null }); return;
        }
        const w = wordRangeAt(a); a = w[0]; b = w[1];
        if (a === b) {   // no word at the caret: open an empty underline span, caret inside it
          edit(a, a, "@{s:u=1}@{/s}", a + 8, "style");
          return;
        }
        setCaret(a, b);
      }
      const host = enclosingStyleSpan(a, b);
      const on = !!(host && parseStyleSpec(specOf(host)).u === "1");
      applyStyle({ u: on ? null : "1" });
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
    // Docs-style CLEAR FORMATTING: over the selection (or the styled run / word at
    // the caret) remove emphasis (bold/italic/strike/code), every @{s:…} style span,
    // and any heading prefix on the touched lines. Links, lists, chips and comments
    // survive — this clears looks, not structure.
    function clearFormatting() {
      const c = readSel() || [selA, selB]; let a = c[0], b = c[1];
      if (a === b) {
        const host = enclosingStyleSpan(a, b);
        if (host) { a = host.s; b = host.e; }
        else { const w = wordRangeAt(a); a = w[0]; b = w[1]; }
      }
      const headAt = p => /^#{1,6}[ \t]+/.test(text.slice(lineStart(p), lineStart(p) + 10));
      if (a === b && !headAt(a)) return;
      snapshot("style");
      // 1) emphasis marks — straddling runs split so only this stretch clears
      for (const kind of ["b", "em", "del", "code"]) {
        const s2 = snapMarks(a, b); a = s2[0]; b = s2[1];
        if (!emphTokens().some(t => t.kind === kind && t.e > a && t.s < b)) continue;
        const r = removeInlineSeg(kind, a, b); a = r[0]; b = r[1];
        render();   // refresh tokens so the next kind sees current offsets
      }
      // 2) style spans the range touches → strip both markers
      let guard = 0;
      while (guard++ < 300) {
        const spans = scanStyleSpans(text);
        const target = spans.find(sp => sp.s >= a && sp.e <= b) ||
          spans.find(sp => sp.e > a && sp.s < b && !(sp.openEnd <= a && sp.closeStart >= b));
        if (!target) break;
        const openLen = target.openEnd - target.s, closeLen = target.e - target.closeStart;
        text = text.slice(0, target.closeStart) + text.slice(target.e);
        text = text.slice(0, target.s) + text.slice(target.openEnd);
        const shift = p => p <= target.s ? p
          : p <= target.openEnd ? target.s
          : p <= target.closeStart ? p - openLen
          : p <= target.e ? target.closeStart - openLen
          : p - openLen - closeLen;
        a = shift(a); b = shift(b);
      }
      // …and a span the range sits strictly INSIDE gets split (pre/post keep the look)
      if (enclosingStyleSpan(a, b)) {
        const r = applyStyleSeg(a, b, { c: null, bg: null, f: null, sz: null, u: null });
        a = r.a; b = r.b;
      }
      // 3) heading lines in the range → normal text
      const starts = [];
      let ls = lineStart(a);
      while (ls <= b) {
        starts.push(ls);
        let le = text.indexOf("\n", ls); if (le < 0) le = text.length;
        if (le >= b || le >= text.length) break;
        ls = le + 1;
      }
      for (let i = starts.length - 1; i >= 0; i--) {
        const s0 = starts[i], m = text.slice(s0, s0 + 10).match(/^#{1,6}[ \t]+/);
        if (!m) continue;
        text = text.slice(0, s0) + text.slice(s0 + m[0].length);
        if (a > s0) a = Math.max(s0, a - m[0].length);
        if (b > s0) b = Math.max(s0, b - m[0].length);
      }
      render(); setCaret(a, Math.min(b, text.length)); onInput();
    }

    /* ----- block-format ops (also exposed through the palette) ----- */
    function curLineRange(pos) { const s = lineStart(pos); let e = text.indexOf("\n", pos); if (e < 0) e = text.length; return [s, e]; }
    const BLOCK_RE = /^(#{1,6}\s+|>\s?|[-*+]\s+\[(?: |x|X)\]\s+|[-*+]\s+|\d+\.\s+)/;
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
      let pfx = prefix;
      // converting a line INTO a numbered item: continue the surrounding run (Task 2's
      // nextOlDigit) instead of hardcoding "1." — otherwise toggling numbering on right
      // after an existing higher-numbered list would spuriously look like a restart.
      const om = !re.test(ln) && /^(\d+)(\.\s+)$/.exec(prefix);
      if (om) { const lead = (ln.match(/^ */) || [""])[0]; pfx = nextOlDigit(lr[0], Math.floor(lead.length / LIST_INDENT)) + om[2]; }
      const nl = re.test(ln) ? ln.replace(re, "") : (pfx + ln.replace(BLOCK_RE, ""));
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
    // Task 2 — restart ordered-list numbering at the caret's line: rewrite its source
    // digit to "1" (computeListMarkers reads a bare "1." after a higher count as an
    // explicit restart) and renumber every FOLLOWING line in the same run (same depth,
    // until the run breaks) to stay consecutive from there — otherwise each of those
    // lines' now-stale old digit would itself mismatch its new expected value and read
    // as ANOTHER unwanted restart, producing "1, 2, 1, <stale>, …" instead of a clean
    // "1, 2, 3, …". Run-boundary rules mirror computeListMarkers: blank lines and deeper
    // nested items don't break the run; a same/shallower-depth line (list or not) does.
    function restartOrderedList() {
      const c = readSel() || [selA, selB], lr = curLineRange(c[0]);
      const m = text.slice(lr[0], lr[1]).match(/^( *)(\d+)(\.\s+)(.*)$/);
      if (!m) return false;
      const depth = Math.floor(m[1].length / LIST_INDENT);
      let end = lr[1], count = 1, out = m[1] + "1" + m[3] + m[4];
      const firstLen = out.length;
      while (end < text.length) {
        const ns = end + 1; let ne = text.indexOf("\n", ns); if (ne < 0) ne = text.length;
        const ln = text.slice(ns, ne), mm2 = ln.match(/^( *)([-*+])\s+/), mm3 = ln.match(/^( *)(\d+)(\.\s+)(.*)$/);
        if (ln.trim() === "") { out += "\n" + ln; end = ne; continue; }               // blank — run stays alive
        if (mm2) {
          const d = Math.floor(mm2[1].length / LIST_INDENT);
          if (d <= depth) break;                                                      // same/shallower bullet — run ends
          out += "\n" + ln; end = ne; continue;                                       // deeper bullet — doesn't touch this depth
        }
        if (mm3) {
          const d = Math.floor(mm3[1].length / LIST_INDENT);
          if (d < depth) break;                                                       // shallower — run ends
          if (d > depth) { out += "\n" + ln; end = ne; continue; }                     // deeper — skip over
          count++; out += "\n" + mm3[1] + count + mm3[3] + mm3[4]; end = ne; continue; // same depth — keep consecutive
        }
        break;                                                                          // plain non-list line — run ends
      }
      edit(lr[0], end, out, lr[0] + firstLen, "block");
      return true;
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
    const ICON_SPARK = '<svg viewBox="0 0 24 24"><path d="M12 4.5l1.7 4.3 4.3 1.7-4.3 1.7L12 16.5l-1.7-4.3L6 10.5l4.3-1.7z"/><path d="M18.2 15.8l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z"/></svg>';
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
      const ql = q.toLowerCase().trim();
      // "@ver" easter egg — a literal, EXACT match (not the usual prefix-discovery rule) that
      // replaces the normal mention lookup entirely: Aaron's per-instance "what am I running"
      // readout. See MDE_VERSION/MDE_LAST_CHANGE above for the source of truth.
      if (ql === "ver") return [{ group: "Version", kind: "ver", lab: "md-editor v" + MDE_VERSION, sub: MDE_LAST_CHANGE }];
      const out = [];
      for (const p of PEOPLE) if (!ql || (p.name + " " + (p.email || "")).toLowerCase().includes(ql))
        out.push({ group: "People", kind: "person", lab: p.name, sub: p.email || "", person: p });
      const pd = parseDate(q);
      if (pd) out.push({ group: "Date", kind: "date", lab: pd.label, sub: "Insert date", iso: pd.iso });
      if (!ql || "today".startsWith(ql) || "date".startsWith(ql)) {
        const t = todayISO(); if (!pd || pd.iso !== t) out.push({ group: "Date", kind: "date", lab: "Today — " + fmtDateLabel(t), sub: "Insert date", iso: t });
      }
      if (!ql || "table".startsWith(ql) || "grid".startsWith(ql)) out.push({ group: "Insert", kind: "table", lab: "Table", sub: "Choose a size" });
      // host @ commands — deliberately invisible on a bare "@"/1-char query: an entry only
      // surfaces once the query is a ≥2-char prefix of its name (typed-toward discovery)
      if (ql.length >= 2) for (const c of ATCMDS)
        if (c.name.toLowerCase().startsWith(ql)) out.push({ group: c.group || "More", kind: "command", lab: c.label || c.name, sub: c.sub || "", cmd: c });
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
          : '<div class="at-ico">' + (it.kind === "date" ? ICON_CAL
            : it.kind === "command" ? ((it.cmd && it.cmd.svg) || ICON_SPARK)
            : it.kind === "ver" ? ICON_SPARK : ICON_TABLE) + "</div>";
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
      // host command: consume the typed "@query" through the normal edit() path (undo-safe,
      // autosave sees the removal via onInput), then hand control to the host
      else if (it.kind === "command") { closeMenu(); edit(from, to, "", from, "chip"); try { it.cmd.run(); } catch (_) {} }
      // "@ver" — the readout already showed in the menu label/sub while typing; committing just
      // consumes the typed "@ver" the same undo-safe way a host command does (nothing to run)
      else if (it.kind === "ver") { closeMenu(); edit(from, to, "", from, "chip"); }
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
      add("bold", "Bold", "Format", () => toggleInline("b"), "strong weight");
      add("italic", "Italic", "Format", () => toggleInline("em"), "emphasis oblique");
      add("underline", "Underline", "Format", () => toggleUnderline(), "u line under");
      add("strike", "Strikethrough", "Format", () => toggleInline("del"), "del cross out");
      add("code", "Inline code", "Format", () => toggleInline("code"), "monospace");
      add("h1", "Heading 1", "Format", () => setHeading(1), "title");
      add("h2", "Heading 2", "Format", () => setHeading(2), "subtitle");
      add("h3", "Heading 3", "Format", () => setHeading(3), "");
      add("bullets", "Bullet list", "Format", () => togglePrefix(/^(\s*)[-*+]\s+(?!\[(?: |x|X)\]\s)/, "- "), "unordered ul");
      add("numbers", "Numbered list", "Format", () => togglePrefix(/^(\s*)\d+\.\s+/, "1. "), "ordered ol");
      add("restartnumbering", "Restart numbering", "Format", () => restartOrderedList(), "ordered ol renumber reset restart start count 1");
      add("task", "Checklist", "Format", () => togglePrefix(/^(\s*)[-*+]\s+\[(?: |x|X)\]\s+/, "- [ ] "), "todo checkbox task list");
      add("quote", "Quote", "Format", () => togglePrefix(/^(\s*)>\s?/, "> "), "blockquote");
      add("color", "Text color…", "Style", () => pushSub("Text color", PAL_COLORS.map(([n, hex]) => subItem("color-" + n, n, () => applyStyle({ c: hex }), swatch(hex))).concat([subItem("color-none", "Default color", () => applyStyle({ c: null }))])), "colour foreground");
      add("hilite", "Highlight…", "Style", () => pushSub("Highlight", PAL_HILITES.map(([n, hex]) => subItem("hl-" + n, n, () => applyStyle({ bg: hex }), swatch(hex))).concat([subItem("hl-none", "No highlight", () => applyStyle({ bg: null }))])), "background marker");
      add("font", "Font…", "Style", () => pushSub("Font", PAL_FONTS.map(([n, key]) => subItem("font-" + key, n, () => applyStyle({ f: key })))), "typeface family");
      add("size", "Font size…", "Style", () => pushSub("Font size", PAL_SIZES.map(([n, v]) => subItem("size-" + n, n, () => applyStyle({ sz: v })))), "scale bigger smaller");
      add("clearfmt", "Clear formatting", "Style", () => clearFormatting(), "remove reset plain");
      add("docstyle", "Document styles…", "Style", () => openDocStyles(), "theme font heading table colors defaults");
      add("table", "Insert table", "Insert", () => { const s = readSel() || [selA, selB]; openGrid(s[0], s[1]); }, "grid");
      add("image", "Insert image…", "Insert", () => pickImage(), "picture photo figure");
      add("link", "Insert link", "Insert", () => insertLink(), "url hyperlink");
      add("rule", "Horizontal rule", "Insert", () => insertRule(), "divider hr line");
      add("zoom", "Zoom…", "View", () => pushSub("Zoom", ZOOM_STEPS.map(z => subItem("zoom-" + Math.round(z * 100), Math.round(z * 100) + "%" + (z === zoom ? "  ✓" : ""), () => setZoom(z)))), "scale magnify view");
      add("theme", "Theme…", "View", () => pushSub("Theme", [["Light", "light"], ["Dark", "dark"], ["Match system", "auto"]].map(p => subItem("theme-" + p[1], p[0] + (getTheme() === p[1] ? "  ✓" : ""), () => setTheme(p[1])))), "light dark system night");
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
    // false => panel+API only, host drives it. The floating button shows in BOTH toolbar and
    // non-toolbar modes: with the built-in toolbar on, it docks top-RIGHT just below the bar.
    const tocButtonEnabled = opts.tocButton !== false;
    // toolbar:true → the headings button docks below the full-width toolbar bar, on the
    // LEFT (see .mde-toc-btn-below in md-editor.css) — Google-Docs-style outline-toggle
    // placement. opts.tabRail (set only by makeTabs) means a tab-reveal handle shares
    // that same left column above it, so the button stacks further down (-below-tabs).
    const tocWithToolbar = !!opts.toolbar;
    const tocBelowTabs = tocWithToolbar && !!opts.tabRail;
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
        tocBtn.type = "button";
        tocBtn.className = "mde-toc-btn" + (tocWithToolbar ? " mde-toc-btn-below" : "") + (tocBelowTabs ? " mde-toc-btn-below-tabs" : "");
        tocBtn.title = "Contents";
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
      if (tocBtn) tocBtn.classList.add("on");
      placeTOC(); refreshTOC();
      if (barRefresh) barRefresh();
    }
    function closeTOC() { if (!tocOpen) return; tocOpen = false; if (tocRoot) tocRoot.classList.remove("open"); if (tocBtn) tocBtn.classList.remove("on"); surface.focus(); if (barRefresh) barRefresh(); }
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
        // headings/quotes/bullets/numbers/checklists: keep the CONTENT, drop the marker prefix
        out.push(inlineToPlain((b.type === "h" || b.type === "bq" || b.type === "li" || b.type === "ol" || b.type === "task") ? ln.slice(b.mlen) : ln));
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

    /* ======================================================================
       ZOOM — a pure view scale (never touches the source). --mde-zoom drives
       calc()'d font sizes in CSS; persisted per user.
       ====================================================================== */
    const ZOOM_STEPS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
    function loadZoom() { try { const v = parseFloat(localStorage.getItem("mde-zoom")); return (v >= 0.5 && v <= 2) ? v : 1; } catch (_) { return 1; } }
    let zoom = loadZoom();
    function setZoom(z) {
      z = Math.max(0.5, Math.min(2, parseFloat(z) || 1));
      zoom = z;
      try { localStorage.setItem("mde-zoom", String(z)); } catch (_) {}
      surface.style.setProperty("--mde-zoom", z);
      if (barRefresh) barRefresh();
    }
    function getZoom() { return zoom; }
    surface.style.setProperty("--mde-zoom", zoom);

    /* ======================================================================
       DOCUMENT STYLES — a %%doc:key=val;…%% meta line (hidden, round-trips in
       the file, so a doc keeps its look wherever it's opened). Every value is
       whitelisted before it reaches the DOM. Keys:
         font/sz/c        body font (FONT_STACKS key) / base size px / text color
         hfont            heading font
         h1c..h3c         heading colors      h1sz..h3sz  heading sizes (px)
         thbg/thc         table header fill / header text color
         tband            table banding color ("none" turns banding off)
         linkc            link color
         lh               line spacing (unitless multiplier, 1.0–3.0; default 1.7)
         ind              paragraph first-line indent (em, 0–6; default 0 = none)
       ====================================================================== */
    const DOC_LINE_RE = /^\s*%%doc:([^%]*)%%\s*$/;
    // Per-paragraph first-line indent (Tab-key, Word-style): a hidden %%ind:N%% line glued
    // directly above ONE paragraph — same convention as %%doc:…%% but scoped to that paragraph
    // instead of the whole document. N counts 0.5in/3em tab-stops (0–6). Fully machine-managed:
    // never peeks, never shown raw (see the render()/hidden[] wiring below).
    const IND_LINE_RE = /^\s*%%ind:(\d+)%%\s*$/;
    function indLevelOf(ln) { const m = IND_LINE_RE.exec(ln || ""); return m ? Math.max(0, Math.min(6, parseInt(m[1], 10))) : 0; }
    const DOC_VARS = ["--mde-doc-font", "--mde-doc-size", "--mde-doc-ink", "--mde-doc-hfont",
      "--mde-doc-h1c", "--mde-doc-h2c", "--mde-doc-h3c", "--mde-doc-h1sz", "--mde-doc-h2sz", "--mde-doc-h3sz",
      "--mde-doc-thbg", "--mde-doc-thc", "--mde-doc-tband", "--mde-doc-linkc", "--mde-doc-lh", "--mde-doc-indent"];
    let docSpec = {};
    function applyDocVars(lines) {
      let raw = null;
      for (let k = 0; k < lines.length; k++) { const m = DOC_LINE_RE.exec(lines[k]); if (m) { raw = m[1]; break; } }
      docSpec = parseStyleSpec(raw || "");
      for (const v of DOC_VARS) surface.style.removeProperty(v);
      const set = (v, val) => surface.style.setProperty(v, val);
      let c;
      if (docSpec.font && FONT_STACKS[docSpec.font]) set("--mde-doc-font", FONT_STACKS[docSpec.font]);
      const bpx = safeNum(docSpec.sz, 10, 32);
      if (bpx != null) set("--mde-doc-size", bpx + "px");
      if (docSpec.c && (c = safeColor(docSpec.c))) set("--mde-doc-ink", c);
      if (docSpec.hfont && FONT_STACKS[docSpec.hfont]) set("--mde-doc-hfont", FONT_STACKS[docSpec.hfont]);
      for (let l = 1; l <= 3; l++) {
        if (docSpec["h" + l + "c"] && (c = safeColor(docSpec["h" + l + "c"]))) set("--mde-doc-h" + l + "c", c);
        const px = safeNum(docSpec["h" + l + "sz"], 10, 72);
        if (px != null) set("--mde-doc-h" + l + "sz", (Math.round(px / (bpx || 16.5) * 1000) / 1000) + "em");
      }
      if (docSpec.thbg && (c = safeColor(docSpec.thbg))) set("--mde-doc-thbg", c);
      if (docSpec.thc && (c = safeColor(docSpec.thc))) set("--mde-doc-thc", c);
      if (docSpec.tband === "none") set("--mde-doc-tband", "transparent");
      else if (docSpec.tband && (c = safeColor(docSpec.tband))) set("--mde-doc-tband", c);
      if (docSpec.linkc && (c = safeColor(docSpec.linkc))) set("--mde-doc-linkc", c);
      const lh = safeNum(docSpec.lh, 1, 3);
      if (lh != null) set("--mde-doc-lh", lh);
      const ind = safeNum(docSpec.ind, 0, 6);
      if (ind != null) set("--mde-doc-indent", ind + "em");
    }
    function getDocStyle() { const o = {}; for (const k in docSpec) o[k] = docSpec[k]; return o; }
    function setDocStyle(props) {
      const cur = {}; for (const k in docSpec) cur[k] = docSpec[k];
      for (const k in props) { if (props[k] == null || props[k] === "") delete cur[k]; else cur[k] = String(props[k]); }
      const spec = styleSpecToStr(cur);
      const lines = text.split("\n");
      let idx = -1, ls = 0;
      for (let k = 0, o = 0; k < lines.length; o += lines[k].length + 1, k++)
        if (DOC_LINE_RE.test(lines[k])) { idx = k; ls = o; break; }
      snapshot("doc");
      let delta = 0, at = 0;
      if (idx >= 0) {
        const le = ls + lines[idx].length;
        if (spec) { const nl = "%%doc:" + spec + "%%"; text = text.slice(0, ls) + nl + text.slice(le); delta = nl.length - (le - ls); at = ls; }
        else { const e2 = le < text.length ? le + 1 : le; text = text.slice(0, ls) + text.slice(e2); delta = -(e2 - ls); at = ls; }
      } else if (spec) {
        const ins = "%%doc:" + spec + "%%\n";
        text = ins + text; delta = ins.length; at = 0;
      }
      const nA = selA >= at ? Math.max(at, selA + delta) : selA, nB = selB >= at ? Math.max(at, selB + delta) : selB;
      render(); setCaret(nA, nB); onInput();
    }

    /* ======================================================================
       Custom color picker — the PROse-design method, ported to vanilla JS:
       an SV area + hue slider + Hex / RGB / HSL fields, all shown at once.
       ====================================================================== */
    function cpClamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
    function cpHexToRgb(hex) {
      let h = (hex || "").replace("#", "").trim();
      if (h.length === 3) h = h.split("").map(c => c + c).join("");
      if (!/^[0-9a-f]{6}$/i.test(h)) return null;
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
    }
    function cpRgbToHex(r, g, b) { return "#" + [r, g, b].map(n => cpClamp(Math.round(n), 0, 255).toString(16).padStart(2, "0")).join(""); }
    function cpRgbToHsv(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      let h = 0;
      if (d) {
        if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
        h *= 60; if (h < 0) h += 360;
      }
      return { h, s: mx ? d / mx : 0, v: mx };
    }
    function cpHsvToRgb(h, s, v) {
      const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
      let r = 0, g = 0, b = 0;
      if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
      else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
      else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
      return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
    }
    function cpRgbToHsl(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
      let h = 0, s = 0;
      if (d) {
        s = d / (1 - Math.abs(2 * l - 1));
        if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
        h *= 60; if (h < 0) h += 360;
      }
      return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
    }
    function cpHslToRgb(h, s, l) {
      s /= 100; l /= 100;
      const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
      let r = 0, g = 0, b = 0;
      if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
      else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
      else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
      return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
    }
    function buildColorPicker(value, onChange) {
      const root = document.createElement("div"); root.className = "mde-cp";
      const seedRgb = cpHexToRgb(value) || { r: 136, g: 136, b: 136 };
      let hsv = cpRgbToHsv(seedRgb.r, seedRgb.g, seedRgb.b);
      root.innerHTML =
        '<div class="mde-cp-sv"><span class="mde-cp-sv-dot"></span></div>' +
        '<div class="mde-cp-hue"><span class="mde-cp-hue-thumb"></span></div>' +
        '<div class="mde-cp-fields">' +
          '<label class="mde-cp-row"><span>HEX</span><input class="mde-cp-tx" data-cp="hex" spellcheck="false"></label>' +
          '<label class="mde-cp-row"><span>RGB</span><div class="mde-cp-triple">' +
            '<input class="mde-cp-num" type="number" data-cp="r"><input class="mde-cp-num" type="number" data-cp="g"><input class="mde-cp-num" type="number" data-cp="b"></div></label>' +
          '<label class="mde-cp-row"><span>HSL</span><div class="mde-cp-triple">' +
            '<input class="mde-cp-num" type="number" data-cp="hh"><input class="mde-cp-num" type="number" data-cp="hs"><input class="mde-cp-num" type="number" data-cp="hl"></div></label>' +
        "</div>";
      const sv = root.querySelector(".mde-cp-sv"), dot = root.querySelector(".mde-cp-sv-dot");
      const hue = root.querySelector(".mde-cp-hue"), thumb = root.querySelector(".mde-cp-hue-thumb");
      const F = {}; root.querySelectorAll("[data-cp]").forEach(el => { F[el.dataset.cp] = el; });
      const hex = () => { const c = cpHsvToRgb(hsv.h, hsv.s, hsv.v); return cpRgbToHex(c.r, c.g, c.b); };
      function paint() {
        sv.style.background = "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), hsl(" + hsv.h + " 100% 50%)";
        dot.style.left = hsv.s * 100 + "%"; dot.style.top = (1 - hsv.v) * 100 + "%"; dot.style.background = hex();
        thumb.style.left = hsv.h / 360 * 100 + "%";
        const c = cpHsvToRgb(hsv.h, hsv.s, hsv.v), hsl = cpRgbToHsl(c.r, c.g, c.b);
        const vals = { hex: hex().toUpperCase(), r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b), hh: hsl.h, hs: hsl.s, hl: hsl.l };
        for (const k in vals) if (document.activeElement !== F[k]) F[k].value = vals[k];
      }
      function push() { paint(); onChange(hex()); }
      function dragTrack(el, move) {
        el.addEventListener("pointerdown", e => {
          e.preventDefault();
          const rect = el.getBoundingClientRect();
          const mv = ev => { move(ev, rect); push(); };
          mv(e);
          const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
          window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
        });
      }
      dragTrack(sv, (ev, rect) => {
        hsv = { h: hsv.h, s: cpClamp((ev.clientX - rect.left) / rect.width, 0, 1), v: cpClamp(1 - (ev.clientY - rect.top) / rect.height, 0, 1) };
      });
      dragTrack(hue, (ev, rect) => { hsv = { h: cpClamp((ev.clientX - rect.left) / rect.width, 0, 1) * 360, s: hsv.s, v: hsv.v }; });
      F.hex.addEventListener("input", () => { const c = cpHexToRgb(F.hex.value); if (c) { hsv = cpRgbToHsv(c.r, c.g, c.b); push(); } });
      const num = (el, fn) => el.addEventListener("input", fn);
      const rgbIn = () => { hsv = cpRgbToHsv(cpClamp(+F.r.value || 0, 0, 255), cpClamp(+F.g.value || 0, 0, 255), cpClamp(+F.b.value || 0, 0, 255)); push(); };
      num(F.r, rgbIn); num(F.g, rgbIn); num(F.b, rgbIn);
      const hslIn = () => { const c = cpHslToRgb(cpClamp(+F.hh.value || 0, 0, 360), cpClamp(+F.hs.value || 0, 0, 100), cpClamp(+F.hl.value || 0, 0, 100)); hsv = cpRgbToHsv(c.r, c.g, c.b); push(); };
      num(F.hh, hslIn); num(F.hs, hslIn); num(F.hl, hslIn);
      root.setHex = h => { const c = cpHexToRgb(h); if (c) { hsv = cpRgbToHsv(c.r, c.g, c.b); paint(); } };
      root.getHex = hex;
      paint();
      return root;
    }

    /* ---- color popover: quick swatches + the custom picker + default/OK ---- */
    const colorPop = document.createElement("div"); colorPop.className = "mde-colorpop"; document.body.appendChild(colorPop);
    let colorPopOpen = false;
    function placePop(el, anchor) {
      el.style.visibility = "hidden"; el.style.left = "0"; el.style.top = "0";
      const r = anchor.getBoundingClientRect(), pr = el.getBoundingClientRect(), M = 10;
      let left = r.left, top = r.bottom + 6;
      if (left + pr.width > window.innerWidth - M) left = window.innerWidth - M - pr.width;
      if (left < M) left = M;
      if (top + pr.height > window.innerHeight - M) top = Math.max(M, r.top - pr.height - 6);
      el.style.left = left + "px"; el.style.top = top + "px"; el.style.visibility = "";
    }
    function closeColorPop() { if (colorPopOpen) { colorPopOpen = false; colorPop.classList.remove("open"); } }
    // o: { value, swatches:[[name,hex]], defaultLabel, extra:[[label,value]], onPick(v|null) }
    function openColorPop(anchor, o) {
      closeColorPop();
      colorPop.innerHTML = "";
      const grid = document.createElement("div"); grid.className = "mde-colorpop-grid";
      (o.swatches || []).forEach(sw => {
        const b = document.createElement("button");
        b.type = "button"; b.className = "mde-colorpop-sw"; b.title = sw[0]; b.style.background = sw[1];
        if (o.value && o.value.toLowerCase() === sw[1].toLowerCase()) b.classList.add("on");
        b.addEventListener("mousedown", e => { e.preventDefault(); closeColorPop(); o.onPick(sw[1]); });
        grid.appendChild(b);
      });
      colorPop.appendChild(grid);
      let pending = o.value || "#c0392b";
      const picker = buildColorPicker(pending, h => { pending = h; });
      colorPop.appendChild(picker);
      const foot = document.createElement("div"); foot.className = "mde-colorpop-foot";
      const mkBtn = (label, cls, fn) => {
        const b = document.createElement("button"); b.type = "button"; b.className = cls; b.textContent = label;
        b.addEventListener("mousedown", e => { e.preventDefault(); fn(); });
        foot.appendChild(b);
      };
      mkBtn(o.defaultLabel || "Default", "mde-colorpop-none", () => { closeColorPop(); o.onPick(null); });
      (o.extra || []).forEach(ex => mkBtn(ex[0], "mde-colorpop-none", () => { closeColorPop(); o.onPick(ex[1]); }));
      const sp = document.createElement("span"); sp.className = "mde-colorpop-spring"; foot.appendChild(sp);
      mkBtn("Apply", "mde-colorpop-ok", () => { closeColorPop(); o.onPick(pending); });
      colorPop.appendChild(foot);
      colorPopOpen = true; colorPop.classList.add("open");
      placePop(colorPop, anchor);
    }
    document.addEventListener("mousedown", e => { if (colorPopOpen && !colorPop.contains(e.target)) closeColorPop(); }, true);

    /* ---- Document-styles dialog (fonts, colors, heading + table looks) ---- */
    let dsScrim = null, dsModal = null;
    const DS_FONTS = [["Default", ""], ["Sans", "sans"], ["Serif", "serif"], ["Poppins", "poppins"], ["Georgia", "georgia"], ["Times", "times"], ["Arial", "arial"], ["Courier", "courier"], ["Mono", "mono"]];
    function dsWell(key, title, swatches, defColorCss, extra) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "mde-ds-well"; b.title = title; b.dataset.dskey = key;
      const paint = () => {
        const v = docSpec[key];
        b.classList.toggle("auto", !v);
        b.style.background = v && v !== "none" ? v : (defColorCss || "transparent");
        b.classList.toggle("none", v === "none");
      };
      paint(); b._paint = paint;
      b.addEventListener("mousedown", e => {
        e.preventDefault();
        openColorPop(b, {
          value: (docSpec[key] && docSpec[key] !== "none") ? docSpec[key] : null,
          swatches, extra,
          onPick: v => { const p = {}; p[key] = v; setDocStyle(p); refreshDs(); },
        });
      });
      return b;
    }
    function dsSelect(key, options) {
      const s = document.createElement("select"); s.className = "mde-ds-select";
      options.forEach(op => { const o = document.createElement("option"); o.value = op[1]; o.textContent = op[0]; s.appendChild(o); });
      s.value = docSpec[key] || "";
      s.addEventListener("change", () => { const p = {}; p[key] = s.value || null; setDocStyle(p); refreshDs(); });
      return s;
    }
    function dsNum(key, ph, lo, hi) {
      const n = document.createElement("input");
      n.type = "number"; n.className = "mde-ds-num"; n.placeholder = ph; n.min = lo; n.max = hi;
      n.value = docSpec[key] || "";
      n.addEventListener("change", () => {
        const v = safeNum(n.value, lo, hi);
        const p = {}; p[key] = v == null ? null : v; setDocStyle(p); refreshDs();
      });
      return n;
    }
    function dsRow(label, ...ctrls) {
      const row = document.createElement("div"); row.className = "mde-ds-row";
      const l = document.createElement("span"); l.className = "mde-ds-k"; l.textContent = label; row.appendChild(l);
      const wrap = document.createElement("span"); wrap.className = "mde-ds-v";
      ctrls.forEach(c => wrap.appendChild(c)); row.appendChild(wrap);
      return row;
    }
    function dsHead(label) { const h = document.createElement("div"); h.className = "mde-ds-h"; h.textContent = label; return h; }
    function refreshDs() {
      if (!dsModal) return;
      dsModal.querySelectorAll(".mde-ds-well").forEach(w => w._paint && w._paint());
      dsModal.querySelectorAll(".mde-ds-select").forEach(s => { if (s.dataset.dskey) s.value = docSpec[s.dataset.dskey] || ""; });
    }
    function buildDsDom() {
      dsScrim = document.createElement("div"); dsScrim.className = "mde-ds-scrim";
      dsModal = document.createElement("div"); dsModal.className = "mde-ds";
      dsModal.setAttribute("role", "dialog"); dsModal.setAttribute("aria-modal", "true"); dsModal.setAttribute("aria-label", "Document styles");
      dsScrim.appendChild(dsModal);
      document.body.appendChild(dsScrim);
      dsScrim.addEventListener("mousedown", e => { if (e.target === dsScrim) closeDocStyles(); });
      dsScrim.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); closeDocStyles(); } });
    }
    function openDocStyles() {
      if (!dsScrim) buildDsDom();
      dsModal.innerHTML = '<div class="mde-ds-title">Document styles<span class="mde-ds-sub">saved inside this document</span></div>';
      const bodyFont = dsSelect("font", DS_FONTS); bodyFont.dataset.dskey = "font";
      const headFont = dsSelect("hfont", DS_FONTS); headFont.dataset.dskey = "hfont";
      const lineSpacing = dsSelect("lh", [["Default", ""], ["Single", "1"], ["1.15", "1.15"], ["1.5", "1.5"], ["Double", "2"]]);
      lineSpacing.dataset.dskey = "lh";
      const paraIndent = dsSelect("ind", [["None", ""], ["0.25in", "1.5"], ["0.5in", "3"]]);
      paraIndent.dataset.dskey = "ind";
      // sections scroll in their own body layer so the scrollbar lives inside the
      // card (matching its height) while the title + actions stay put
      const dsBody = document.createElement("div"); dsBody.className = "mde-ds-body";
      dsBody.appendChild(dsHead("Body"));
      dsBody.appendChild(dsRow("Font", bodyFont, dsNum("sz", "16.5", 10, 32)));
      dsBody.appendChild(dsRow("Text color", dsWell("c", "Text color", PAL_COLORS, "var(--mde-ink)")));
      dsBody.appendChild(dsRow("Line spacing", lineSpacing));
      dsBody.appendChild(dsRow("Paragraph indent", paraIndent));
      dsBody.appendChild(dsHead("Headings"));
      dsBody.appendChild(dsRow("Font", headFont));
      dsBody.appendChild(dsRow("H1", dsWell("h1c", "H1 color", PAL_COLORS, "var(--mde-green-deep)"), dsNum("h1sz", "30", 10, 72)));
      dsBody.appendChild(dsRow("H2", dsWell("h2c", "H2 color", PAL_COLORS, "var(--mde-green-deep)"), dsNum("h2sz", "24", 10, 72)));
      dsBody.appendChild(dsRow("H3", dsWell("h3c", "H3 color", PAL_COLORS, "var(--mde-green-deep)"), dsNum("h3sz", "20", 10, 72)));
      dsBody.appendChild(dsHead("Tables"));
      dsBody.appendChild(dsRow("Header fill", dsWell("thbg", "Header row fill", PAL_COLORS, "var(--mde-green)")));
      dsBody.appendChild(dsRow("Header text", dsWell("thc", "Header row text", [["White", "#ffffff"], ["Black", "#111111"]].concat(PAL_COLORS), "#fff")));
      dsBody.appendChild(dsRow("Row banding", dsWell("tband", "Even-row fill", PAL_HILITES, "var(--mde-leaf)", [["No banding", "none"]])));
      dsBody.appendChild(dsHead("Links"));
      dsBody.appendChild(dsRow("Link color", dsWell("linkc", "Link color", PAL_COLORS, "var(--mde-green)")));
      dsModal.appendChild(dsBody);
      const foot = document.createElement("div"); foot.className = "mde-ds-actions";
      const reset = document.createElement("button"); reset.type = "button"; reset.className = "mde-ds-reset"; reset.textContent = "Reset all";
      reset.addEventListener("click", e => {
        e.preventDefault();
        const p = {}; for (const k in docSpec) p[k] = null;
        setDocStyle(p); openDocStyles();   // rebuild with cleared state
      });
      const done = document.createElement("button"); done.type = "button"; done.className = "mde-ds-ok"; done.textContent = "Done";
      done.addEventListener("click", e => { e.preventDefault(); closeDocStyles(); });
      foot.appendChild(reset); foot.appendChild(done);
      dsModal.appendChild(foot);
      dsScrim.classList.add("open");
      done.focus();
    }
    function closeDocStyles() { if (dsScrim) dsScrim.classList.remove("open"); closeColorPop(); surface.focus(); }

    /* ======================================================================
       TOOLBAR (opts.toolbar) — a Docs-style formatting bar docked above the
       surface (sticky inside the scrolling stage). Buttons run the same
       internals as the palette; state mirrors the caret via caretFormats().
       ====================================================================== */
    const TB_ICONS = {
      undo: '<svg viewBox="0 0 24 24"><path d="M3.5 8h11a6 6 0 1 1 0 12h-6"/><path d="M7.5 4 3.5 8l4 4"/></svg>',
      redo: '<svg viewBox="0 0 24 24"><path d="M20.5 8h-11a6 6 0 1 0 0 12h6"/><path d="M16.5 4l4 4-4 4"/></svg>',
      bullets: '<svg viewBox="0 0 24 24"><path d="M9.5 7h10M9.5 12h10M9.5 17h10"/><circle class="fill" cx="5" cy="7" r="1.4"/><circle class="fill" cx="5" cy="12" r="1.4"/><circle class="fill" cx="5" cy="17" r="1.4"/></svg>',
      numbers: '<svg viewBox="0 0 24 24"><path d="M10 7h10M10 12h10M10 17h10"/><path d="M4 5.6 5.2 5v4M3.3 13.1c0-.6.5-1 1.1-1s1.1.4 1.1 1c0 1-2.3 1.3-2.3 2.9h2.4"/></svg>',
      task: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4" width="7" height="7" rx="1.8"/><path d="M5.5 7.4l1.4 1.4 2.4-2.6M14 7.5h6.5M14 16.5h6.5"/><rect x="3.5" y="13" width="7" height="7" rx="1.8"/></svg>',
      quote: '<svg viewBox="0 0 24 24"><path d="M5 6.5v11M9.5 8h10M9.5 12h10M9.5 16h7"/></svg>',
      link: '<svg viewBox="0 0 24 24"><path d="M9.5 14.5l5-5"/><path d="M8 11 6 13a3.6 3.6 0 0 0 5 5l2-2"/><path d="M16 13l2-2a3.6 3.6 0 0 0-5-5l-2 2"/></svg>',
      image: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2.2"/><circle cx="9" cy="10" r="1.6"/><path d="M4.5 17l4.7-4.7a1.5 1.5 0 0 1 2.1 0L18 19M14.5 15.5 16.7 13.3a1.5 1.5 0 0 1 2.1 0l1.7 1.7"/></svg>',
      table: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M3.5 14.5h17M9 9.5V19.5M15 9.5V19.5"/></svg>',
      clear: '<svg viewBox="0 0 24 24"><path d="M6 5h12M12 5v4.5M12 14v5"/><path d="M4.5 19.5 19.5 4.5"/></svg>',
      styles: '<svg viewBox="0 0 24 24"><path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z"/><circle class="fill" cx="13.5" cy="6.5" r="1.1"/><circle class="fill" cx="17.5" cy="10.5" r="1.1"/><circle class="fill" cx="8.5" cy="7.5" r="1.1"/><circle class="fill" cx="6.5" cy="12.5" r="1.1"/></svg>',
      chev: '<svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg>',
      sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5V5M12 19v2.5M4.4 4.4 6 6M18 18l1.6 1.6M2.5 12H5M19 12h2.5M4.4 19.6 6 18M18 6l1.6-1.6"/></svg>',
      moon: '<svg viewBox="0 0 24 24"><path d="M20 14.2A8 8 0 0 1 9.8 4 7 7 0 1 0 20 14.2z"/></svg>',
      system: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="12" rx="2"/><path d="M9 21h6M12 17v4"/></svg>',
      // the PROse-design (Lucide) highlighter
      hilite: '<svg viewBox="0 0 24 24"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>',
    };
    const toolbarEnabled = !!opts.toolbar;
    // The toolbar is a sticky, OPAQUE bar at the top of the scrolling stage — document text
    // scrolling up vanishes cleanly under it (see .mde-toolbar in md-editor.css). A sticky
    // child pins to the stage's CONTENT box, so the stage's own padding-top is a strip ABOVE
    // the bar it doesn't cover — text would peep there. Publish that padding as --mde-sb-pad
    // so the bar can paint the page paper up over it (an upward box-shadow). Static px in
    // every real consumer, so a build-time read + a resize refresh is plenty.
    let barEl = null;
    function syncToolbarPad() {
      if (!barEl || !barEl.parentNode) return;
      try { barEl.style.setProperty("--mde-sb-pad", getComputedStyle(barEl.parentNode).paddingTop || "0px"); } catch (_) {}
    }
    let barB = {};   // toolbar element refs for state reflection
    function tbBtn(bar2, html, title, run, cls) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "mde-tb-btn" + (cls ? " " + cls : ""); b.innerHTML = html;
      b.title = title; b.setAttribute("aria-label", title);
      b.addEventListener("mousedown", e => { e.preventDefault(); run(b); if (barRefresh) barRefresh(); });
      bar2.appendChild(b);
      return b;
    }
    function tbSep(bar2) { const s = document.createElement("span"); s.className = "mde-tb-sep"; bar2.appendChild(s); }
    // wrap a <select> so it carries the little dropdown chevron (native arrow is hidden)
    function tbDd(bar2, sel) {
      const w = document.createElement("span"); w.className = "mde-tb-dd";
      w.appendChild(sel);
      const c = document.createElement("span"); c.className = "mde-tb-chev"; c.innerHTML = TB_ICONS.chev;
      w.appendChild(c);
      bar2.appendChild(w);
      return w;
    }
    // Docs-style point sizes; stored as the @{s:sz=…} em multiple (11 = the body size)
    const TB_SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36].map(n => [String(n), n === 11 ? "1" : String(Math.round(n / 11 * 100) / 100)]);
    function buildToolbar() {
      const parent = surface.parentNode;
      if (!parent) return;
      const bar = document.createElement("div");
      bar.className = "mde-toolbar"; bar.setAttribute("contenteditable", "false");
      // undo / redo
      barB.undo = tbBtn(bar, TB_ICONS.undo, "Undo (⌘Z)", () => doUndo());
      barB.redo = tbBtn(bar, TB_ICONS.redo, "Redo (⇧⌘Z)", () => doRedo());
      tbSep(bar);
      // zoom
      const zoomSel = document.createElement("select");
      zoomSel.className = "mde-tb-select mde-tb-zoom"; zoomSel.title = "Zoom";
      ZOOM_STEPS.forEach(z => { const o = document.createElement("option"); o.value = String(z); o.textContent = Math.round(z * 100) + "%"; zoomSel.appendChild(o); });
      zoomSel.addEventListener("change", () => { setZoom(zoomSel.value); surface.focus(); setCaret(selA, selB); });
      tbDd(bar, zoomSel); barB.zoom = zoomSel;
      tbSep(bar);
      // paragraph style
      const headSel = document.createElement("select");
      headSel.className = "mde-tb-select mde-tb-head"; headSel.title = "Paragraph style";
      [["Normal text", "p"], ["Heading 1", "1"], ["Heading 2", "2"], ["Heading 3", "3"]].forEach(op => {
        const o = document.createElement("option"); o.value = op[1]; o.textContent = op[0]; headSel.appendChild(o);
      });
      headSel.addEventListener("change", () => {
        const f = caretFormats();
        if (headSel.value === "p") { if (f.h) setHeading(f.h); }
        else setHeading(+headSel.value);
        surface.focus();
      });
      tbDd(bar, headSel); barB.head = headSel;
      tbSep(bar);
      // font family + size (selection-level, invisible @{s:…} styling)
      const fontSel = document.createElement("select");
      fontSel.className = "mde-tb-select mde-tb-font"; fontSel.title = "Font (selection)";
      DS_FONTS.forEach(op => { const o = document.createElement("option"); o.value = op[1]; o.textContent = op[0]; fontSel.appendChild(o); });
      fontSel.addEventListener("change", () => { applyStyle({ f: fontSel.value || null }); surface.focus(); });
      tbDd(bar, fontSel); barB.font = fontSel;
      tbSep(bar);
      const sizeSel = document.createElement("select");
      sizeSel.className = "mde-tb-select mde-tb-size"; sizeSel.title = "Text size (selection)";
      TB_SIZES.forEach(op => { const o = document.createElement("option"); o.value = op[1]; o.textContent = op[0]; sizeSel.appendChild(o); });
      const sizeCustom = document.createElement("option"); sizeCustom.hidden = true; sizeCustom.value = "custom";
      sizeSel.appendChild(sizeCustom); sizeSel.value = "1";
      sizeSel.addEventListener("change", () => { if (sizeSel.value === "custom") return; applyStyle({ sz: sizeSel.value !== "1" ? sizeSel.value : null }); surface.focus(); });
      tbDd(bar, sizeSel); barB.size = sizeSel; barB.sizeCustom = sizeCustom;
      tbSep(bar);
      // inline formatting
      barB.b = tbBtn(bar, "<b>B</b>", "Bold (⌘B)", () => toggleInline("b"));
      barB.em = tbBtn(bar, "<i>I</i>", "Italic (⌘I)", () => toggleInline("em"), "i");
      barB.u = tbBtn(bar, "<u>U</u>", "Underline (⌘U)", () => toggleUnderline());
      barB.del = tbBtn(bar, "<s>S</s>", "Strikethrough (⇧⌘X)", () => toggleInline("del"));
      // text color + highlight
      barB.color = tbBtn(bar, '<span class="mde-tb-A">A</span><span class="mde-tb-cbar"></span>', "Text color", b => {
        openColorPop(b, { value: curStyleKey("c"), swatches: PAL_COLORS, onPick: v => { applyStyle({ c: v }); } });
      }, "mde-tb-color");
      barB.hilite = tbBtn(bar, TB_ICONS.hilite + '<span class="mde-tb-cbar mde-tb-cbar-h"></span>', "Highlight color", b => {
        openColorPop(b, { value: curStyleKey("bg"), swatches: PAL_HILITES, defaultLabel: "No highlight", onPick: v => { applyStyle({ bg: v }); } });
      }, "mde-tb-color");
      tbSep(bar);
      // blocks
      barB.li = tbBtn(bar, TB_ICONS.bullets, "Bullet list", () => togglePrefix(/^(\s*)[-*+]\s+(?!\[( |x|X)\]\s)/, "- "));
      barB.ol = tbBtn(bar, TB_ICONS.numbers, "Numbered list", () => togglePrefix(/^(\s*)\d+\.\s+/, "1. "));
      barB.task = tbBtn(bar, TB_ICONS.task, "Checklist", () => togglePrefix(/^(\s*)[-*+]\s+\[(?: |x|X)\]\s+/, "- [ ] "));
      barB.bq = tbBtn(bar, TB_ICONS.quote, "Quote", () => togglePrefix(/^(\s*)>\s?/, "> "));
      tbSep(bar);
      // inserts
      tbBtn(bar, TB_ICONS.link, "Insert link (⌘K)", () => insertLink());
      tbBtn(bar, TB_ICONS.image, "Insert image", () => pickImage());
      tbBtn(bar, TB_ICONS.table, "Insert table", () => { const s = readSel() || [selA, selB]; openGrid(s[0], s[1]); });
      tbSep(bar);
      tbBtn(bar, TB_ICONS.clear, "Clear formatting", () => clearFormatting());
      tbBtn(bar, TB_ICONS.styles, "Document styles", () => openDocStyles());
      const spring = document.createElement("span"); spring.className = "mde-tb-spring"; bar.appendChild(spring);
      // theme: light / dark / match-system
      const seg = document.createElement("span"); seg.className = "mde-tb-theme";
      barB.thLight = tbBtn(seg, TB_ICONS.sun, "Light", () => { setTheme("light"); });
      barB.thDark = tbBtn(seg, TB_ICONS.moon, "Dark", () => { setTheme("dark"); });
      barB.thAuto = tbBtn(seg, TB_ICONS.system, "Match system", () => { setTheme("auto"); });
      bar.appendChild(seg);
      parent.insertBefore(bar, surface);
      // Publish the stage's top padding to the bar so its box-shadow can paint the page paper
      // up over that strip (see .mde-toolbar / --mde-sb-pad in md-editor.css), keeping it in
      // sync on resize. Purely presentational — never touches the contenteditable surface.
      barEl = bar;
      syncToolbarPad();
      try { window.addEventListener("resize", syncToolbarPad, { passive: true }); } catch (_) {}
      barRefresh = updateToolbar;
      try { new MutationObserver(updateToolbar).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] }); } catch (_) {}
      updateToolbar();
    }
    function curStyleKey(k) {
      const sp = enclosingStyleSpan(selA, selB);
      return sp ? (parseStyleSpec(specOf(sp))[k] || null) : null;
    }
    function updateToolbar() {
      if (!barB.b) return;
      const f = caretFormats();
      barB.b.classList.toggle("on", f.b);
      barB.em.classList.toggle("on", f.em);
      barB.u.classList.toggle("on", f.u);
      barB.del.classList.toggle("on", f.del);
      barB.li.classList.toggle("on", f.li && !f.task);
      barB.ol.classList.toggle("on", f.ol);
      barB.task.classList.toggle("on", !!f.task);
      barB.bq.classList.toggle("on", f.bq);
      barB.head.value = f.h ? String(Math.min(f.h, 3)) : "p";
      const sp = enclosingStyleSpan(selA, selB), m = sp ? parseStyleSpec(specOf(sp)) : {};
      barB.font.value = (m.f && FONT_STACKS[m.f]) ? m.f : "";
      const szv = m.sz || "1";
      if (TB_SIZES.some(op => op[1] === szv)) barB.size.value = szv;
      else { barB.sizeCustom.textContent = String(Math.round((parseFloat(szv) || 1) * 11)); barB.size.value = "custom"; }
      barB.zoom.value = String(zoom);
      const cbar = barB.color.querySelector(".mde-tb-cbar"); if (cbar) cbar.style.background = (m.c && safeColor(m.c)) || "var(--mde-ink)";
      const hbar = barB.hilite.querySelector(".mde-tb-cbar"); if (hbar) hbar.style.background = (m.bg && safeColor(m.bg)) || "transparent";
      const th = getTheme();
      barB.thLight.classList.toggle("on", th === "light");
      barB.thDark.classList.toggle("on", th === "dark");
      barB.thAuto.classList.toggle("on", th === "auto");
    }
    if (toolbarEnabled) buildToolbar();

    /* A small whitelisted command API so a HOST TOOLBAR can run the essential
       editing actions (the same internals the palette drives). Keeps formatting
       logic in one place; the host just paints buttons and calls ed.cmd("bold"). */
    function cmd(name) {
      switch (name) {
        case "bold":    return toggleInline("b");
        case "italic":  return toggleInline("em");
        case "strike":  return toggleInline("del");
        case "code":    return toggleInline("code");
        case "underline": return toggleUnderline();
        case "image":   return pickImage();
        case "docstyle":return openDocStyles();
        case "h1":      return setHeading(1);
        case "h2":      return setHeading(2);
        case "h3":      return setHeading(3);
        case "bullets": return togglePrefix(/^(\s*)[-*+]\s+(?!\[(?: |x|X)\]\s)/, "- ");
        case "numbers": return togglePrefix(/^(\s*)\d+\.\s+/, "1. ");
        case "restartnumbering": return restartOrderedList();
        case "task":    return togglePrefix(/^(\s*)[-*+]\s+\[(?: |x|X)\]\s+/, "- [ ] ");
        case "quote":   return togglePrefix(/^(\s*)>\s?/, "> ");
        case "link":    return insertLink();
        case "rule":    return insertRule();
        case "table":   { const s = readSel() || [selA, selB]; return openGrid(s[0], s[1]); }
        case "clearfmt":return clearFormatting();
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
      openPalette, applyStyle, clearStyle, clearFormatting, toggleUnderline,
      // DOCS-6 — theme control: "dark" | "light" | "auto".
      setTheme, getTheme, toggleTheme,
      // zoom — a pure view scale (0.5–2), persisted per user.
      setZoom, getZoom,
      // document styles — the hidden %%doc:…%% line (fonts, colors, heading/table looks).
      openDocStyles, setDocStyle, getDocStyle,
      // images — insert programmatically (src is sanitized; relative paths allowed).
      insertImage: insertImageSrc,
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
      // Markdown demotion — per-user "accept markdown" toggle (persisted). On (default): marks
      // (emphasis + heading/quote prefixes) never render — Word feel; off: raw marks stay
      // visible (classic). A host settings UI can drive these.
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
      // place the selection programmatically (source offsets) — host toolbars & tests
      setSelection(a, b) { setCaret(Math.max(0, Math.min(a | 0, text.length)), b == null ? null : Math.max(0, Math.min(b | 0, text.length))); },
      // formats active at the caret/selection: {b, em, del, code, u, h, li, ol, task, bq}
      getFormats() { return caretFormats(); },
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
         atCommands?,      // forwarded to makeEditor (host @ commands, e.g. @buddy)
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
    reveal.type = "button"; reveal.className = "mde-tab-reveal" + (opts.toolbar ? " mde-tab-reveal-below" : ""); reveal.title = "Show tabs";
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
      atCommands: opts.atCommands,           // forward host @ commands (easter-egg entries)
      toc: opts.toc,
      tocButton: opts.tocButton,
      toolbar: opts.toolbar,                 // forward the Docs-style formatting bar
      tabRail: true,                         // tells the TOC button a tab-reveal handle shares its left column (stack below it)
      imageUpload: opts.imageUpload,         // forward the image hooks
      resolveImageSrc: opts.resolveImageSrc,
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
    window.MDE_VERSION = MDE_VERSION;   // same stamp the "@ver" easter egg reads; handy for a host footer/console check
  }
