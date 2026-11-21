// render.js — one pure function per view. Data in, a DOM node out. No clock, no network, no markup sinks:
// every string from a record enters the DOM as a text node.
const NONE = "Nothing recorded yet.";
const UNREADABLE = "This record can't be read. Nothing from it is shown.";
const SENTENCE =
  "Your record stays on this laptop. When you ask a question, the lines needed to answer it go to a rented model.";

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null && text !== "") n.textContent = String(text);
  return n;
}

function refusedWords(n) {
  return n + (n === 1 ? " line refused" : " lines refused");
}

function readNode(d) {
  return el("p", "unreadable", UNREADABLE);
}

function itemLine(it) {
  const li = el("li", "line");
  li.append(el("span", "date", it && it.date));
  li.append(document.createTextNode(" — "));
  li.append(el("span", "source", it && it.source));
  li.append(document.createTextNode(" — "));
  li.append(el("span", "text", it && it.text));
  return li;
}

function section(title, items) {
  const s = el("section", "group");
  s.append(el("h3", "", title));
  const ul = el("ul", "lines");
  for (const it of items) ul.append(itemLine(it));
  s.append(ul);
  return s;
}

// The record model — shown on Where-we-left-off (and, without the derived counts, on Ledger).
function facts(d, opts) {
  const root = document.createDocumentFragment();
  if (!d || d.unreadable === true) {
    root.append(readNode(d));
    return root;
  }
  const head = el("header", "facthead");
  if (d.project !== undefined && d.project !== null) head.append(el("h2", "", d.project));
  if (d.slug !== undefined && d.slug !== null) head.append(el("p", "slug", d.slug));
  if (d.last_touch) head.append(el("p", "fresh", "Last entry dated " + d.last_touch));
  if (opts && opts.gap && d.gap_days !== undefined && d.gap_days !== null) {
    head.append(el("p", "gap", "Quiet for " + d.gap_days + " days"));
  }
  if (opts && opts.needs && d.needs !== undefined && d.needs !== null) {
    head.append(el("p", "needs", d.needs + " open"));
  }
  if (opts && opts.refused && d.refused_count > 0) {
    head.append(el("p", "refused", refusedWords(d.refused_count)));
  }
  root.append(head);
  const groups = [
    ["Decisions", d.decisions],
    ["Open items", d.open_items],
    ["Follow-ups", d.follow_ups],
  ];
  let any = false;
  for (const pair of groups) {
    if (Array.isArray(pair[1]) && pair[1].length) {
      any = true;
      root.append(section(pair[0], pair[1]));
    }
  }
  if (!any) root.append(el("p", "empty", NONE));
  return root;
}

export function renderWhere(wlo) {
  return facts(wlo, { gap: true, needs: true, refused: true });
}

export function renderRecord(state) {
  return facts(state, { gap: false, needs: false, refused: true });
}

export function renderToday(brief) {
  const root = document.createDocumentFragment();
  if (!brief || brief.unreadable === true) {
    root.append(readNode(brief));
    return root;
  }
  root.append(el("h2", "", "Today"));
  const lines = Array.isArray(brief.lines) ? brief.lines : [];
  if (lines.length) {
    const ul = el("ul", "lines today");
    for (const l of lines) {
      const li = el("li", "line");
      li.append(el("strong", "project", l && l.project));
      li.append(document.createTextNode(" — "));
      li.append(el("span", "date", l && l.date));
      li.append(document.createTextNode(" — "));
      li.append(el("span", "source", l && l.source));
      li.append(document.createTextNode(" — "));
      li.append(el("span", "text", l && l.text));
      if (l && l.kind) li.append(el("em", "kind", " " + l.kind));
      ul.append(li);
    }
    root.append(ul);
  }
  const quiet = Array.isArray(brief.gone_quiet) ? brief.gone_quiet : [];
  if (quiet.length) {
    const ul = el("ul", "quiet");
    for (const g of quiet) {
      const li = el("li", "quietrow");
      li.append(el("strong", "name", g && g.name));
      li.append(document.createTextNode(" — last entry dated " + ((g && g.last_touch) || "")));
      li.append(document.createTextNode(" — quiet " + ((g && g.quiet_days) || 0) + " days"));
      li.append(document.createTextNode(" — " + ((g && g.needs) || 0) + " open"));
      ul.append(li);
    }
    root.append(ul);
  }
  if (brief.refused_count > 0) root.append(el("p", "refused", refusedWords(brief.refused_count)));
  if (!lines.length && !quiet.length) root.append(el("p", "empty", NONE));
  return root;
}

export function renderProjects(index, brief, filter) {
  const root = document.createDocumentFragment();
  root.append(el("h2", "", "Projects"));
  const f = filter || "all";
  const rows = Array.isArray(index && index.projects) ? index.projects : [];
  const ul = el("ul", "projects");
  for (const r of rows) {
    const unreadable = r.readable !== true;
    if (!unreadable) {
      if (f === "open" || f === "waiting") {
        if (!(r.needs > 0)) continue;
      } else if (f === "done") {
        if (r.needs > 0) continue;
      }
    }
    const li = el("li", "project" + (unreadable ? " unreadable-row" : ""));
    if (unreadable) {
      li.append(el("span", "name", r.name));
      li.append(document.createTextNode(" — "));
      li.append(el("span", "unreadable", UNREADABLE));
    } else {
      li.append(el("span", "name", r.name));
      li.append(document.createTextNode(" — last entry dated " + (r.last_touch || "")));
      li.append(document.createTextNode(" — " + (r.needs || 0) + " open"));
      if (r.refused_count > 0) li.append(document.createTextNode(" — " + refusedWords(r.refused_count)));
    }
    ul.append(li);
  }
  root.append(ul);
  return root;
}

function safePath(p) {
  if (typeof p !== "string") return false;
  if (p.indexOf(":") >= 0) return false;
  if (p.charAt(0) === "/") return false;
  if (p.indexOf("..") >= 0) return false;
  return /^[a-z0-9_][a-z0-9_./-]*$/i.test(p);
}

// `image_path` in the record is relative to the project (`inbox/<name>.png`), so the URI is built
// from the project's own slug here: `/desk/projects/<slug>/<image_path>`. The slug is passed in
// because the inbox record does not carry it. Two spellings must both be safe: the slug and the path.
export function renderInbox(inbox, slug) {
  const root = document.createDocumentFragment();
  if (inbox && inbox.unreadable === true) {
    root.append(readNode(inbox));
    return root;
  }
  const items = Array.isArray(inbox && inbox.items) ? inbox.items : [];
  if (!items.length) {
    root.append(el("p", "empty", NONE));
    return root;
  }
  root.append(el("h2", "", "Inbox"));
  const ul = el("ul", "inbox");
  for (const it of items) {
    const li = el("li", "item");
    li.append(el("span", "date", String((it && it.at) || "").slice(0, 10)));
    li.append(document.createTextNode(" — "));
    li.append(el("span", "source", it && it.source));
    li.append(document.createTextNode(" — "));
    li.append(el("span", "text", it && it.text));
    if (it && it.image_path) {
      const fig = el("figure", "capture");
      if (safePath(slug) && safePath(it.image_path)) {
        const im = document.createElement("img");
        im.setAttribute("src", "/desk/projects/" + slug + "/" + it.image_path);
        im.setAttribute("alt", it.image_path);
        fig.append(im);
      }
      fig.append(el("figcaption", "", it.image_path));
      li.append(fig);
    }
    ul.append(li);
  }
  root.append(ul);
  return root;
}

export function renderReceipts(receipts) {
  const root = document.createDocumentFragment();
  if (receipts && receipts.unreadable === true) {
    root.append(readNode(receipts));
    return root;
  }
  const runs = Array.isArray(receipts && receipts.runs) ? receipts.runs : [];
  root.append(el("h2", "", "Receipts"));
  if (!runs.length) {
    root.append(el("p", "empty", NONE));
    return root;
  }
  const table = el("table", "receipts");
  const head = el("tr", "head");
  for (const h of ["Run", "Outcome", "Date", "ms", "tokens", "cost", "stepped in"]) head.append(el("th", "", h));
  table.append(head);
  for (const x of runs) {
    const tr = el("tr", "run");
    tr.append(el("td", "run", x && x.run));
    tr.append(el("td", "outcome", x && x.outcome));
    tr.append(el("td", "date", String((x && x.at) || "").slice(0, 10)));
    tr.append(el("td", "ms", x && x.ms));
    tr.append(el("td", "tokens", x && x.tokens));
    tr.append(el("td", "cost", x && x.cost));
    tr.append(el("td", "stepped", x && x.stepped_in));
    table.append(tr);
  }
  root.append(table);
  return root;
}

export function renderEgress(egress) {
  const root = document.createDocumentFragment();
  root.append(el("p", "sentence", SENTENCE));
  if (egress && egress.unreadable === true) {
    root.append(readNode(egress));
    return root;
  }
  const rows = Array.isArray(egress && egress.rows) ? egress.rows : [];
  root.append(el("h2", "", "What left"));
  if (!rows.length) {
    root.append(el("p", "empty", NONE));
  } else {
    const table = el("table", "egress");
    const head = el("tr", "head");
    for (const h of ["Run", "Date", "What was sent", "Where it went", "Why", "bytes"]) head.append(el("th", "", h));
    table.append(head);
    for (const x of rows) {
      const tr = el("tr", "row");
      tr.append(el("td", "run", x && x.run));
      tr.append(el("td", "date", String((x && x.at) || "").slice(0, 10)));
      tr.append(el("td", "what", x && x.what));
      tr.append(el("td", "where", x && x.where));
      tr.append(el("td", "why", x && x.why));
      tr.append(el("td", "bytes", x && x.bytes));
      table.append(tr);
    }
    root.append(table);
  }
  if (egress && egress.none_rows !== undefined && egress.none_rows !== null) {
    root.append(el("p", "none", egress.none_rows + " run(s) sent nothing"));
  }
  return root;
}
