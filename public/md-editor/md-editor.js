/* ============================================================================
   md-editor.js — project-agnostic live-markdown editor (vanilla, no deps).
   `text` is the single source of truth; the DOM is a pure projection of it.
   API:  const ed = makeEditor(surface, opts)
     opts.onInput()      call (debounce it) after every content change
     opts.onSave()       called on Cmd/Ctrl-S
     opts.people         [{ name, email, accent?, accentBg?, accentBorder? }]
     opts.scrollParent   element whose scroll dismisses popovers (optional)
     ed.setText(v) / ed.getText() / ed.focus() / ed.caretToEnd() / ed.dismiss()
   See README.md for the %%comment%% syntax, tables, and Supabase wiring.
   ============================================================================ */
  function makeEditor(surface, opts) {
    opts = opts || {};
    const onInput = opts.onInput || function () {};
    const onSave = opts.onSave || function () {};
    const PEOPLE = opts.people || [];
    const scrollParent = opts.scrollParent || null;
    // self-contained HTML escape (no host dependency)
    const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g,
      c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

    let text = "";
    let selA = 0, selB = 0;
    let leaves = [];     // { el, s, len }  — every source char lives in exactly one leaf
    let blocks = [];     // { el, s, e }    — one per source line
    let toks = [];       // { el, s, e }    — inline spans, for reveal
    let composing = false, compAt = null;
    let suppress = false;
    let undo = [], redo = [], lastType = null, lastAt = 0;

    /* ----- inline tokenizer (operates in absolute source offsets) ----- */
    function findSingle(s, ch, from) {
      for (let j = from; j < s.length; j++)
        if (s[j] === ch && s[j + 1] !== ch && s[j - 1] !== ch && j > from) return j;
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
            }
          }
        }
        if (c === "%" && content[i + 1] === "%") {
          const cl = content.indexOf("%%", i + 2);   // a %%…%% comment: hidden by render, kept in source
          if (cl > i + 1) { pushText(i); out.push({ kind: "comment", s: base + i, e: base + cl + 2, inner: content.slice(i + 2, cl) }); i = cl + 2; ts = i; continue; }
          // unclosed %% (mid-typing): fall through to plain text
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
      if (ln.length === 0)                         return { type: "blank", s, e, raw: ln };
      return { type: "p", s, e, raw: ln };
    }

    /* ----- DOM building ----- */
    function leafSpan(str, s, cls) {
      const sp = document.createElement("span");
      sp.className = cls; sp.dataset.s = s; sp.dataset.len = str.length;
      sp.appendChild(document.createTextNode(str));
      leaves.push({ el: sp, s, len: str.length });
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
        if (t.kind === "comment") {
          // three leaves (%% + inner + %%) keep the leaf-coverage invariant; CSS hides it
          const tok = document.createElement("span"); tok.className = "tok cm";
          toks.push({ el: tok, s: t.s, e: t.e });
          tok.appendChild(leafSpan("%%", t.s, "mk"));
          tok.appendChild(leafSpan(t.inner, t.s + 2, "seg"));
          tok.appendChild(leafSpan("%%", t.e - 2, "mk"));
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
    function render() {
      suppress = true;
      surface.textContent = "";
      leaves = []; blocks = []; toks = [];
      const lines = text.split("\n");
      const starts = []; { let o = 0; for (let k = 0; k < lines.length; k++) { starts.push(o); o += lines[k].length + 1; } }
      let i = 0;
      while (i < lines.length) {
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
        if (b.type === "h" || b.type === "bq" || b.type === "li" || b.type === "ol") {
          div.appendChild(leafSpan(b.raw.slice(0, b.mlen), b.s, "blockmk"));
          appendInline(div, b.raw.slice(b.mlen), b.s + b.mlen);
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
    }

    /* ----- tables: GFM detected in source, rendered house-style; cells are
       native-edited islands that reserialize the table back into the source ----- */
    function isRow(ln) { return /^\s*\|.*\|\s*$/.test(ln); }
    function isDelim(ln) { const t = ln.trim(); return /^[\s|:\-]+$/.test(t) && t.indexOf("-") >= 0 && t.indexOf("|") >= 0; }
    // column widths persist as a "%%cols:34,33,33%%" comment line directly above the table (percent of table width)
    function isColsLine(ln) { return /^\s*%%cols:[^%]*%%\s*$/.test(ln); }
    function colsFromCSV(csv) { if (!csv) return null; const a = String(csv).split(",").map(x => parseFloat(x)).filter(n => !isNaN(n) && n > 0); return a.length ? a : null; }
    function parseCols(ln) { const m = /^\s*%%cols:([^%]*)%%\s*$/.exec(ln); return m ? colsFromCSV(m[1]) : null; }
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
    function rowGFM(cells, cols) { let o = "|"; for (let c = 0; c < cols; c++) o += " " + (cells[c] != null ? String(cells[c]) : "") + " |"; return o; }
    function emitTable(head, body, widths) {
      const cols = head.length;
      const out = [];
      if (widths && widths.length) out.push("%%cols:" + widths.slice(0, cols).join(",") + "%%");  // re-emitted on EVERY edit so widths survive
      out.push(rowGFM(head, cols), "|" + " --- |".repeat(cols));
      body.forEach(r => out.push(rowGFM(r, cols)));
      return out.join("\n");
    }
    function cellOf(node) { if (!node) return null; const el = node.nodeType === 3 ? node.parentElement : node; return el && el.closest ? el.closest(".mcell") : null; }
    function selInCell() { const s = document.getSelection(); return !!(s && s.rangeCount && cellOf(s.anchorNode)); }

    function mkCell(tag, content, r, c) {
      const cell = document.createElement(tag); cell.className = "mcell";
      cell.setAttribute("contenteditable", "plaintext-only");
      cell.dataset.r = r; cell.dataset.c = c; cell.textContent = content;
      cell.addEventListener("input", e => { e.stopPropagation(); if (!composing) syncTable(cell); });
      cell.addEventListener("keydown", onCellKey);
      cell.addEventListener("paste", e => { e.stopPropagation(); e.preventDefault(); const d = ((e.clipboardData || window.clipboardData).getData("text/plain") || "").replace(/[\r\n|]+/g, " "); document.execCommand("insertText", false, d); });
      cell.addEventListener("copy", e => e.stopPropagation());
      cell.addEventListener("cut", e => e.stopPropagation());
      return cell;
    }
    function renderTable(rawLines, s, e) {
      let widths = null, off = 0;
      if (isColsLine(rawLines[0])) { widths = parseCols(rawLines[0]); off = 1; }   // claim a leading %%cols%% line
      const head = splitCells(rawLines[off]);
      const body = rawLines.slice(off + 2).map(splitCells);
      const cols = Math.max(head.length, body.reduce((m, r) => Math.max(m, r.length), 0), 1);
      const wrap = document.createElement("div"); wrap.className = "mtable-wrap"; wrap.setAttribute("contenteditable", "false");
      wrap.dataset.s = s; wrap.dataset.e = e;
      if (widths) wrap.dataset.cols = widths.join(",");
      const table = document.createElement("table"); table.className = "mtable";
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
    }
    function repositionGrips(wrap) {
      const layer = wrap.querySelector(".mcol-grips"), table = wrap.querySelector("table.mtable");
      if (!layer || !table) return;
      const ths = [...table.querySelectorAll("thead th")], wr = wrap.getBoundingClientRect();
      [...layer.children].forEach((grip, c) => { if (ths[c]) grip.style.left = (ths[c].getBoundingClientRect().right - wr.left) + "px"; });
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
      text = text.slice(0, s) + emitTable(m.head, m.body, widths) + text.slice(e);
      render(); onInput();
    }
    function tableMatrix(wrap) {
      return { head: [...wrap.querySelectorAll("thead th")].map(cellText), body: [...wrap.querySelectorAll("tbody tr")].map(tr => [...tr.children].map(cellText)) };
    }
    function caretInCell(cell) {
      const sel = document.getSelection(); if (!sel || !sel.rangeCount) return 0;
      const node = sel.focusNode; if (!cell.contains(node)) return (cell.textContent || "").length;
      let total = 0; const w = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT); let n;
      while ((n = w.nextNode())) { if (n === node) return total + sel.focusOffset; total += n.nodeValue.length; }
      return total;
    }
    function syncTable(cell) {
      const wrap = cell.closest(".mtable-wrap"); if (!wrap) return;
      const cap = { tblS: +wrap.dataset.s, r: +cell.dataset.r, c: +cell.dataset.c, off: caretInCell(cell) };
      const s = +wrap.dataset.s, e = +wrap.dataset.e, m = tableMatrix(wrap);
      const widths = colsFromCSV(wrap.dataset.cols);   // keep persisted widths through a cell edit
      snapshot("cell");
      text = text.slice(0, s) + emitTable(m.head, m.body, widths) + text.slice(e);
      render(); restoreCell(cap); onInput();
    }
    function restoreCell(cap) {
      const wrap = surface.querySelector('.mtable-wrap[data-s="' + cap.tblS + '"]'); if (!wrap) return;
      const cell = wrap.querySelector('.mcell[data-r="' + cap.r + '"][data-c="' + cap.c + '"]'); if (!cell) return;
      cell.focus({ preventScroll: true });
      const tn = cell.firstChild && cell.firstChild.nodeType === 3 ? cell.firstChild : null;
      const r = document.createRange();
      if (tn) r.setStart(tn, Math.min(cap.off, tn.nodeValue.length)); else r.setStart(cell, 0);
      r.collapse(true);
      const sel = document.getSelection(); suppress = true; sel.removeAllRanges(); sel.addRange(r); suppress = false;
    }
    function allCells(wrap) { return [...wrap.querySelectorAll(".mcell")]; }
    function focusCell(cell) { if (!cell) return; cell.focus({ preventScroll: true }); const r = document.createRange(); r.selectNodeContents(cell); r.collapse(false); const s = document.getSelection(); suppress = true; s.removeAllRanges(); s.addRange(r); suppress = false; }
    function atCellStart(cell) { const s = document.getSelection(); return s && s.isCollapsed && caretInCell(cell) === 0; }
    function atCellEnd(cell) { const s = document.getSelection(); return s && s.isCollapsed && caretInCell(cell) === (cell.textContent || "").length; }
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
      const cell = e.currentTarget;
      if (e.key === "Tab") { e.preventDefault(); e.stopPropagation(); moveCell(cell, e.shiftKey ? -1 : 1, !e.shiftKey); return; }
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); enterCell(cell); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); exitTable(cell.closest(".mtable-wrap"), 1); return; }
      if ((e.metaKey || e.ctrlKey) && /^[biuBIU]$/.test(e.key)) { e.preventDefault(); e.stopPropagation(); return; }
      if (e.key === "ArrowRight" && atCellEnd(cell)) { e.preventDefault(); e.stopPropagation(); moveCell(cell, 1, false); return; }
      if (e.key === "ArrowLeft" && atCellStart(cell)) { e.preventDefault(); e.stopPropagation(); moveCell(cell, -1, false); return; }
      if (e.key === "Backspace" && (cell.textContent || "").length === 0) {
        e.preventDefault(); e.stopPropagation();
        const wrap = cell.closest(".mtable-wrap");
        tableIsEmpty(wrap) ? deleteTable(wrap) : moveCell(cell, -1, false);
      }
    }
    function replaceTable(wrap, head, body, widths) {
      const s = +wrap.dataset.s, e = +wrap.dataset.e; snapshot("table");
      if (widths === undefined) widths = colsFromCSV(wrap.dataset.cols);
      text = text.slice(0, s) + emitTable(head, body, widths) + text.slice(e); render(); onInput();
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
      if (dir > 0) { if (e >= text.length) { snapshot("table"); text = text.slice(0, e) + "\n"; render(); } setCaret(Math.min(e + 1, text.length)); }
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
      for (const t of toks) t.el.classList.toggle("on", selA <= t.e && selB >= t.s);
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
    function domToOffset(node, offset) {
      if (node === surface) {
        const ch = surface.childNodes[Math.min(offset, surface.childNodes.length - 1)];
        const blk = blocks.find(b => b.el === ch);
        return blk ? blk.s : text.length;
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
      if (blk) return offset > 0 ? blk.e : blk.s;
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
      render();
      setCaret(caret == null ? a + ins.length : caret);
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

    /* ----- input handling (everything goes through here) ----- */
    surface.addEventListener("beforeinput", e => {
      if (cellOf(e.target)) return;   // table cells edit natively, then reserialize
      if (composing) return;
      const t = e.inputType;
      const cur = readSel() || [selA, selB];
      const a = cur[0], b = cur[1];
      if (t === "insertText") { e.preventDefault(); const d = e.data == null ? "" : e.data; edit(a, b, d, a + d.length, "type"); }
      else if (t === "insertReplacementText") { e.preventDefault(); const d = (e.dataTransfer && e.dataTransfer.getData("text")) || e.data || ""; edit(a, b, d, a + d.length, "rep"); }
      else if (t === "insertParagraph" || t === "insertLineBreak") { e.preventDefault(); edit(a, b, "\n", a + 1, "nl"); }
      else if (t === "deleteContentBackward") { e.preventDefault(); if (a !== b) edit(a, b, "", a, "del"); else if (a > 0) { const ch = atomicBefore(a); if (ch) edit(ch.s, a, "", ch.s, "del"); else { const p = prevG(a); edit(p, a, "", p, "del"); } } }
      else if (t === "deleteContentForward")  { e.preventDefault(); if (a !== b) edit(a, b, "", a, "del"); else if (b < text.length) { const ch = atomicAfter(b); if (ch) edit(b, ch.s + ch.len, "", a, "del"); else { const x = nextG(b); edit(b, x, "", a, "del"); } } }
      else if (t === "deleteWordBackward")    { e.preventDefault(); if (a !== b) edit(a, b, "", a, "del"); else { const p = wordLeft(a); edit(p, a, "", p, "del"); } }
      else if (t === "deleteWordForward")     { e.preventDefault(); if (a !== b) edit(a, b, "", a, "del"); else { const x = wordRight(b); edit(b, x, "", a, "del"); } }
      else if (t === "deleteSoftLineBackward" || t === "deleteHardLineBackward") { e.preventDefault(); if (a !== b) edit(a, b, "", a, "del"); else { const ls = lineStart(a); edit(ls, a, "", ls, "del"); } }
      else if (t === "historyUndo") { e.preventDefault(); restore(undo, redo); }
      else if (t === "historyRedo") { e.preventDefault(); restore(redo, undo); }
      else { e.preventDefault(); } // paste/cut/drop handled by their own events; ignore the rest
    });
    surface.addEventListener("paste", e => {
      if (cellOf(e.target)) return;
      e.preventDefault();
      const d = ((e.clipboardData || window.clipboardData).getData("text/plain") || "").replace(/\r\n?/g, "\n");
      const cur = readSel() || [selA, selB];
      edit(cur[0], cur[1], d, null, "paste");
    });
    surface.addEventListener("copy", e => {
      if (cellOf(e.target)) return;
      const cur = readSel(); if (!cur || cur[0] === cur[1]) return;
      e.preventDefault(); e.clipboardData.setData("text/plain", text.slice(cur[0], cur[1]));
    });
    surface.addEventListener("cut", e => {
      if (cellOf(e.target)) return;
      const cur = readSel(); if (!cur) return;
      e.preventDefault();
      if (cur[0] !== cur[1]) { e.clipboardData.setData("text/plain", text.slice(cur[0], cur[1])); edit(cur[0], cur[1], "", cur[0], "cut"); }
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
      }
      if (menuOpen) {
        if (e.key === "ArrowDown") { e.preventDefault(); if (items.length) { msel = (msel + 1) % items.length; highlightMenu(); } return; }
        if (e.key === "ArrowUp")   { e.preventDefault(); if (items.length) { msel = (msel - 1 + items.length) % items.length; highlightMenu(); } return; }
        if (e.key === "Enter" || e.key === "Tab") { if (items.length) { e.preventDefault(); commit(msel); return; } }
        if (e.key === "Escape") { e.preventDefault(); closeMenu(); return; }
      }
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "z" || e.key === "Z")) { e.preventDefault(); e.shiftKey ? restore(redo, undo) : restore(undo, redo); return; }
      if (mod && e.key === "y") { e.preventDefault(); restore(redo, undo); return; }
      if (mod && (e.key === "b" || e.key === "B")) { e.preventDefault(); wrap("**"); return; }
      if (mod && (e.key === "i" || e.key === "I")) { e.preventDefault(); wrap("*"); return; }
      if (mod && (e.key === "s" || e.key === "S")) { e.preventDefault(); onSave(); return; }
      if (e.key === "Tab") { e.preventDefault(); const c = readSel() || [selA, selB]; edit(c[0], c[1], "  ", c[0] + 2, "type"); return; }
    });
    function wrap(mk) {
      const c = readSel() || [selA, selB], a = c[0], b = c[1];
      if (a === b) edit(a, b, mk + mk, a + mk.length, "wrap");
      else edit(a, b, mk + text.slice(a, b) + mk, b + 2 * mk.length, "wrap");
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
        selA = cur[0]; selB = cur[1]; applyReveal(); syncMenu();
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

    document.addEventListener("mousedown", e => {
      if ((menuOpen && !menu.contains(e.target)) || (gridOpen && !gridPop.contains(e.target) && !surface.contains(e.target))) { closeMenu(); closeGrid(); }
    }, true);
    const stage = scrollParent || surface.closest(".editor-stage") || surface.parentElement;
    if (stage) stage.addEventListener("scroll", () => { closeMenu(); closeGrid(); });
    function dismiss() { closeMenu(); closeGrid(); }

    return {
      setText(v) { dismiss(); text = (v == null ? "" : String(v)).replace(/\r\n?/g, "\n"); undo = []; redo = []; lastType = null; selA = selB = 0; render(); },
      getText() { return text; },
      focus() { surface.focus(); },
      caretToEnd() { setCaret(text.length); },
      dismiss,
    };
  }

  /* ======================================================================
     MarkdownTabs — a project-agnostic tabbed-document wrapper around makeEditor.
     One editor surface; switching a tab swaps the markdown in/out. Tab IDS ARE
     OPAQUE STRINGS supplied by the host — this widget holds NO identity, sync, or
     persistence logic (the host owns those via the hooks below). Styled by
     --mde-tab-* tokens.

       makeTabs(container, {
         tabs:[{id,title,dim?}], activeId?, people?, emptyLabel?,
         loadTab(id) -> markdown (string|Promise),   // REQUIRED to show content
         onTabInput(id),   // content changed — host debounces + saves getText()
         onTabSave(id),    // Cmd/Ctrl-S — host flushes
         onSelect(prevId,nextId),  // before switching — host flushes prev
         onRename(id,title),       // inline rename committed
         onAddTab() -> {id,title} | Promise | null,  // host creates the tab
       })
     Instance: setTabs(list,selectId?) · addTab(t,select?) · renameTab(id,title) ·
       selectTab(id) · getActiveId() · getText() · setText(v) · getEditor() · focus()
     ====================================================================== */
  function makeTabs(container, opts) {
    opts = opts || {};
    const loadTab = opts.loadTab || function () { return ""; };
    const tabsState = [];       // [{ id, title, dim }]
    let activeId = null, loading = false, renaming = null;

    container.classList.add("mde-tabs");
    container.innerHTML = "";
    const rail = document.createElement("div"); rail.className = "mde-tabrail";
    const stage = document.createElement("div"); stage.className = "editor-stage mde-tab-stage";
    const surface = document.createElement("div"); surface.className = "md-surface";
    // makeEditor doesn't make its surface editable — the host owns that. The tabs
    // wrapper creates the surface, so it sets it here (a host can flip it off for
    // a read-only view).
    surface.setAttribute("contenteditable", "true");
    surface.setAttribute("spellcheck", "true");
    stage.appendChild(surface);
    container.appendChild(rail);
    container.appendChild(stage);

    const ed = makeEditor(surface, {
      people: opts.people || [],
      scrollParent: stage,
      onInput: function () { if (!loading && opts.onTabInput) opts.onTabInput(activeId); },
      onSave:  function () { if (opts.onTabSave) opts.onTabSave(activeId); },
    });

    function renderRail() {
      rail.innerHTML = "";
      for (const t of tabsState) {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "mde-tab" + (t.id === activeId ? " active" : "") + (t.dim ? " dim" : "");
        el.dataset.id = t.id;
        const label = document.createElement("span");
        label.className = "mde-tab-label";
        label.textContent = t.title || "Untitled";
        el.appendChild(label);
        el.addEventListener("click", function () { if (!renaming) selectTab(t.id); });
        if (opts.onRename)
          el.addEventListener("dblclick", function (e) { e.preventDefault(); beginRename(t, label); });
        rail.appendChild(el);
      }
      if (opts.onAddTab) {
        const add = document.createElement("button");
        add.type = "button"; add.className = "mde-tab-add"; add.setAttribute("aria-label", "Add tab");
        add.textContent = "+";
        add.addEventListener("click", addViaHost);
        rail.appendChild(add);
      }
      if (!tabsState.length) {
        const empty = document.createElement("div");
        empty.className = "mde-tab-empty";
        empty.textContent = opts.emptyLabel || "No documents yet";
        rail.appendChild(empty);
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
      ed.focus();
    }

    function beginRename(t, labelEl) {
      renaming = t.id;
      labelEl.contentEditable = "true";
      labelEl.spellcheck = false;
      labelEl.focus();
      const r = document.createRange(); r.selectNodeContents(labelEl);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      function commit(save) {
        labelEl.contentEditable = "false";
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
      tabsState.push({ id: res.id, title: res.title || "Untitled", dim: false });
      renderRail();
      selectTab(res.id);
    }

    const api = {
      setTabs(list, selectId) {
        tabsState.length = 0;
        for (const t of (list || [])) tabsState.push({ id: t.id, title: t.title || "Untitled", dim: !!t.dim });
        activeId = null;
        renderRail();
        const first = selectId || (tabsState[0] && tabsState[0].id);
        if (first) selectTab(first); else { loading = true; ed.setText(""); loading = false; }
      },
      addTab(t, select) {
        tabsState.push({ id: t.id, title: t.title || "Untitled", dim: !!t.dim });
        renderRail();
        if (select !== false) selectTab(t.id);
      },
      renameTab(id, title) { const t = tabsState.find(x => x.id === id); if (t) { t.title = title; renderRail(); } },
      selectTab,
      getActiveId() { return activeId; },
      getText() { return ed.getText(); },
      setText(v) { loading = true; ed.setText(v); loading = false; },
      getEditor() { return ed; },
      focus() { ed.focus(); },
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
