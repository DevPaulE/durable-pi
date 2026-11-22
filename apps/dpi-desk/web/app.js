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

// ---------------------------------------------------------------- chat (WO-6)
// One session per project, named desk-<slug>. The page finds or creates it through /v1, sends a
// message with a unique requestId and renders the settled answer as text. A failure is one plain
// sentence in the right pane — never a status code, never the shell's 502 body, never in the centre.
const chat = { device: null, slug: null, sessionId: null, agent: "main", busy: false, seq: 0 };

/** The project the chat is about: the page in view, or the first project when none is selected. */
function slugInView() {
  const rows = (state.index && state.index.projects) || [];
  if (state.page !== "today" && state.page !== "projects" && state.selected) return state.selected;
  return rows.length ? rows[0].slug : null;
}

function chatLog() {
  return pane("chat-log");
}

function addMessage(who, text) {
  const p = document.createElement("p");
  p.className = "msg " + who;
  p.textContent = String(text);
  const log = chatLog();
  if (log) {
    log.append(p);
    log.scrollTop = log.scrollHeight;
  }
  return p;
}

function addNotice(text) {
  const p = document.createElement("p");
  p.className = "notice";
  p.textContent = text;
  const log = chatLog();
  if (log) log.append(p);
}

const DOWN_TEXT = "The desk's assistant isn't running right now.";

/** Is the sentence already on screen? The pane, not a flag beside it, is the state: a latch kept
 *  somewhere else drifts every time the pane is emptied (bfaa11c) and then suppresses a real failure.
 *  Asking the pane means a cleared pane re-arms the sentence, and a sentence already said is not said
 *  twice — however many redraws, keystrokes or retries happen in between. */
function downShownInPane() {
  const log = chatLog();
  if (!log) return false;
  for (const n of log.querySelectorAll(".notice")) if (n.textContent === DOWN_TEXT) return true;
  return false;
}

function backendDown() {
  if (!downShownInPane()) addNotice(DOWN_TEXT);
  return false;
}

async function v1Json(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
}

function pickModel(device) {
  const id = (device && device.defaultModel) || "";
  const models = (device && device.models) || [];
  const found = models.find((m) => m && m.id === id);
  return { provider: (found && found.provider) || "faux", modelId: id || "echo" };
}

function pickCwd(device) {
  const dirs = (device && device.startDirs) || [];
  return dirs[0] || (device && device.codeDir) || ".";
}

/** Empty the chat pane. Called on every project switch, so one project's lines never sit under another's.
 * Nothing else to do: the once-only latch lives in the pane, so emptying the pane re-arms it. */
function clearChat() {
  const log = chatLog();
  if (log) put(log, null);
}

/** The text of one transcript item: `text` for a user line, the `text` blocks for an assistant one. */
function transcriptItemText(it) {
  if (!it) return "";
  if (typeof it.text === "string") return it.text;
  const blocks = Array.isArray(it.blocks) ? it.blocks : [];
  return blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

/** Load the session's own thread into the (already cleared) pane, so a switch and a reload show it. */
async function loadHistory() {
  if (!chat.sessionId) return;
  try {
    const r = await v1Json("GET", messagePath("transcript"));
    if (!r.ok) return;
    const items = r.json && Array.isArray(r.json.items) ? r.json.items : [];
    for (const it of items) {
      const text = transcriptItemText(it);
      if (!text) continue;
      if (it.kind === "user") addMessage("you", text);
      else if (it.kind === "assistant") addMessage("desk", text);
    }
  } catch {
    /* the pane stays empty rather than showing another project's thread */
  }
}

function setChatWhere(slug) {
  const el = pane("chat-where");
  if (!el) return;
  const rows = (state.index && state.index.projects) || [];
  const row = rows.find((r) => r.slug === slug);
  el.textContent = row ? row.name : "Chat";
}

/** Find or create the project's session; the agent address is `main` (the session's root). */
async function ensureChat(slug) {
  if (!slug) return false;
  if (chat.slug === slug && chat.sessionId) return true;
  // A switch: empty the pane first, so the previous project's thread cannot survive into this one.
  clearChat();
  setChatWhere(slug);
  try {
    if (!chat.device) {
      const device = await v1Json("GET", "/v1/device");
      if (!device.ok) return backendDown();
      chat.device = device.json;
    }
    const sessions = await v1Json("GET", "/v1/sessions");
    if (!sessions.ok) return backendDown();
    const list = Array.isArray(sessions.json) ? sessions.json : [];
    const name = "desk-" + slug;
    let session = list.find((s) => s && s.name === name);
    if (!session) {
      const created = await v1Json("POST", "/v1/sessions", {
        name,
        cwd: pickCwd(chat.device),
        model: pickModel(chat.device),
      });
      if (!created.ok) return backendDown();
      session = created.json;
    }
    const id = session && session.id ? String(session.id) : "";
    if (!id) return backendDown();
    chat.slug = slug;
    chat.sessionId = id;
    // Then show this project's own thread, if it has one. A reload lands here too.
    await loadHistory();
    return true;
  } catch {
    return backendDown();
  }
}

function messagePath(leaf) {
  return "/v1/sessions/" + chat.sessionId + "/agents/" + chat.agent + "/" + leaf;
}

function transcriptText(json) {
  const list = Array.isArray(json) ? json : (json && (json.items || json.entries || json.messages)) || [];
  if (!Array.isArray(list)) return "";
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (!e) continue;
    const role = e.role || e.kind;
    if (role && role !== "assistant" && role !== "agent") continue;
    const text = typeof e.text === "string" ? e.text : (typeof e.content === "string" ? e.content : "");
    if (text) return text;
  }
  return "";
}

async function fallbackTranscript() {
  try {
    const r = await v1Json("GET", messagePath("transcript"));
    if (!r.ok) return;
    const text = transcriptText(r.json);
    if (text) addMessage("desk", text);
  } catch {
    /* the send path already reported the failure */
  }
}

async function settled(text) {
  addMessage("desk", text);
  // A write may have landed a new ledger line: re-read the data files and re-render, no reload.
  await refreshDesk();
}

async function pollSubmission(submissionId) {
  for (let i = 0; i < 10; i++) {
    const r = await v1Json("GET", "/v1/sessions/" + chat.sessionId + "/submissions/" + submissionId + "?waitMs=30000");
    if (r.status === 200 && r.json && r.json.status === "done" && r.json.answer) {
      await settled(String(r.json.answer.text ?? ""));
      return;
    }
    if (!r.ok && r.status !== 202) return backendDown();
  }
  addNotice("Still working on that one — the answer will appear here.");
}

async function send() {
  if (chat.busy) return;
  const input = pane("chat-input");
  const text = ((input && input.value) || "").trim();
  if (!text) return;
  const ready = await ensureChat(slugInView());
  if (!ready) return;
  chat.busy = true;
  chat.seq += 1;
  const requestId = "req-" + chat.seq + "-" + Math.random().toString(36).slice(2, 12);
  addMessage("you", text);
  input.value = "";
  try {
    const res = await v1Json("POST", messagePath("messages"), { content: text, requestId, waitMs: 300000 });
    if (res.status === 202 && res.json && res.json.submissionId) {
      await pollSubmission(res.json.submissionId);
    } else if (res.ok && res.json && res.json.status === "done" && res.json.answer) {
      await settled(String(res.json.answer.text ?? ""));
    } else if (res.ok && res.json && res.json.status === "unanswered") {
      addMessage("desk", "The assistant didn't answer that one.");
    } else if (!res.ok) {
      // A reply that is not ok is a failure the same as a thrown error. The shell answers 502 for a
      // dead backend, and a 502 is a *completed* fetch — it never lands in the catch below, so the
      // failure has to be read off the reply. The transcript read is a long shot; the sentence is not.
      await fallbackTranscript();
      backendDown();
    } else {
      await fallbackTranscript();
    }
  } catch {
    backendDown();
  } finally {
    chat.busy = false;
  }
}

async function stopChat() {
  if (!chat.sessionId) return;
  try {
    const res = await v1Json("POST", messagePath("abort"), {});
    if (!res.ok) backendDown();
  } catch {
    backendDown();
  }
}

async function refreshDesk() {
  state.index = await readJson("projects.json");
  state.brief = await readJson("views/brief.json");
  renderNav();
  await drawCentre();
}

function wireChat() {
  const sendButton = pane("chat-send");
  if (sendButton) sendButton.addEventListener("click", () => { void send(); });
  const input = pane("chat-input");
  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void send();
      }
    });
  }
  const stopButton = pane("chat-stop");
  if (stopButton) stopButton.addEventListener("click", () => { void stopChat(); });
}

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
    body.append(renderInbox(data, slug));
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
  // Chat follows the project in view — including Today, which uses the first project.
  await ensureChat(slugInView());
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
  wireChat();
  state.index = await readJson("projects.json");
  state.brief = await readJson("views/brief.json");
  renderNav();
  await drawCentre();
  // No click at all still ends with a live chat target.
  await ensureChat(slugInView());
}

main();
