// app.js — the shell for the three-pane page. It reads the desk's data files (same origin, /desk/… only)
// and hands each one to a pure render function in render.js. It decides nothing about the record; it
// chooses which view is on screen and which pane is open.
import {
  renderToday,
  renderProjects,
  renderWhere,
  renderRecord,
  renderInbox,
  renderReceipts,
  renderEgress,
} from "./render.js";

const DATA = "/desk";

async function readJson(rel) {
  try {
    const res = await fetch(DATA + "/" + rel);
    if (!res.ok) return { missing: true, status: res.status };
    return await res.json();
  } catch (e) {
    return { missing: true, status: 0 };
  }
}

function pane(id) {
  return document.getElementById(id);
}

function put(node, child) {
  node.textContent = "";
  if (child) node.append(child);
}

function freshLine(project) {
  const p = document.createElement("p");
  p.className = "fresh";
  p.textContent = project && project.last_touch
    ? "Last entry dated " + project.last_touch
    : "No dated entry yet.";
  return p;
}

const state = {
  index: null,
  brief: null,
  selected: null,
  page: "today",
};

function currentRow() {
  if (!state.selected || !state.index) return null;
  for (const r of state.index.projects || []) if (r.slug === state.selected) return r;
  return null;
}

function renderNav() {
  const left = pane("pane-left");
  const frag = document.createDocumentFragment();

  const today = document.createElement("button");
  today.className = "navlink" + (state.page === "today" ? " active" : "");
  today.textContent = "Today";
  today.addEventListener("click", () => select("today"));
  frag.append(today);

  const projects = document.createElement("button");
  projects.className = "navlink" + (state.page === "projects" ? " active" : "");
  projects.textContent = "All projects";
  projects.addEventListener("click", () => select("projects"));
  frag.append(projects);

  const heading = document.createElement("p");
  heading.className = "navhead";
  heading.textContent = "Projects";
  frag.append(heading);

  const ul = document.createElement("ul");
  ul.className = "nav-projects";
  for (const r of (state.index && state.index.projects) || []) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.className = "navlink" + (state.selected === r.slug ? " active" : "");
    if (r.readable !== true) {
      b.textContent = "\u2022 " + r.name + " (unreadable record)";
    } else {
      b.textContent = "\u2022 " + r.name;
    }
    b.addEventListener("click", () => select("where", r.slug));
    li.append(b);
    ul.append(li);
  }
  frag.append(ul);
  put(left, frag);
}

function renderTabs() {
  const bar = document.createElement("div");
  bar.className = "tabs";
  if (state.page === "today" || state.page === "projects") return bar;
  const pages = [
    ["where", "Where we left off"],
    ["record", "Ledger"],
    ["inbox", "Inbox"],
    ["receipts", "Receipts"],
    ["egress", "What left"],
  ];
  const back = document.createElement("button");
  back.className = "tab back";
  back.textContent = "Today";
  back.addEventListener("click", () => select("today"));
  bar.append(back);
  for (const pair of pages) {
    const b = document.createElement("button");
    b.className = "tab" + (state.page === pair[0] ? " active" : "");
    b.textContent = pair[1];
    const slug = state.selected;
    b.addEventListener("click", () => select(pair[0], slug));
    bar.append(b);
  }
  return bar;
}

function centreHead(title) {
  const head = document.createElement("header");
  head.className = "pagehead";
  const h = document.createElement("h1");
  h.textContent = title;
  head.append(h);
  head.append(freshLine(currentRow()));
  return head;
}

async function drawCentre() {
  const centre = pane("pane-centre");
  const row = currentRow();
  const title = state.page === "today" || state.page === "projects"
    ? "Desk"
    : (row ? row.name : "Desk");

  if (state.page === "today") {
    put(centre, null);
    centre.append(centreHead(title));
    const body = document.createElement("div");
    body.className = "pagebody";
    if (!state.brief || state.brief.missing) {
      const p = document.createElement("p");
      p.className = "missing";
      p.textContent = "The brief has not been written yet.";
      body.append(p);
    } else {
      body.append(renderToday(state.brief));
    }
    centre.append(body);
    return;
  }

  if (state.page === "projects") {
    put(centre, null);
    centre.append(centreHead(title));
    const body = document.createElement("div");
    body.className = "pagebody";
    if (!state.index || state.index.missing) {
      const p = document.createElement("p");
      p.className = "missing";
      p.textContent = "The project index has not been written yet.";
      body.append(p);
    } else {
      body.append(renderProjects(state.index, state.brief, "all"));
    }
    centre.append(body);
    return;
  }

  const slug = state.selected;
  if (!slug) {
    put(centre, null);
    centre.append(centreHead(title));
    return;
  }

  const files = {
    where: "projects/" + slug + "/views/where-we-left-off.json",
    record: "projects/" + slug + "/state.json",
    inbox: "projects/" + slug + "/inbox.json",
    receipts: "projects/" + slug + "/views/receipts.json",
    egress: "projects/" + slug + "/views/egress.json",
  };
  const data = await readJson(files[state.page]);
  put(centre, null);
  centre.append(centreHead(title));
  centre.append(renderTabs());
  const body = document.createElement("div");
  body.className = "pagebody";
  if (data && data.missing) {
    const p = document.createElement("p");
    p.className = "missing";
    p.textContent = state.page === "inbox"
      ? "This project has no captured items."
      : "This page has no file yet.";
    body.append(p);
  } else if (state.page === "where") {
    body.append(renderWhere(data));
  } else if (state.page === "record") {
    body.append(renderRecord(data));
  } else if (state.page === "inbox") {
    body.append(renderInbox(data));
  } else if (state.page === "receipts") {
    body.append(renderReceipts(data));
  } else if (state.page === "egress") {
    body.append(renderEgress(data));
  }
  centre.append(body);
}

async function select(page, slug) {
  state.page = page;
  if (slug !== undefined) state.selected = slug;
  renderNav();
  await drawCentre();
}

function wireToggles() {
  const right = pane("pane-right");
  if (window.innerWidth < 1100) right.classList.add("collapsed");
  for (const b of document.querySelectorAll("[data-toggle]")) {
    b.addEventListener("click", () => {
      const target = pane("pane-" + b.dataset.toggle);
      if (target) target.classList.toggle("collapsed");
    });
  }
}

async function main() {
  wireToggles();
  state.index = await readJson("projects.json");
  state.brief = await readJson("views/brief.json");
  renderNav();
  await drawCentre();
}

main();
