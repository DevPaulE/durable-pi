// The placeholder page. Lists the projects from projects.json, then prints each data file the desk
// keeps for a project, plus the cross-project brief. Data only; no layout decisions.
const DATA = "/desk";
const FILE = (rel) => `${DATA}/${rel}`;

async function show(section, path) {
  const el = document.createElement("section");
  const h = document.createElement("h2");
  h.textContent = path;
  el.append(h);
  const pre = document.createElement("pre");
  try {
    const res = await fetch(FILE(path));
    pre.textContent = res.ok ? await res.text() : `(${res.status} — no such file)`;
  } catch (e) {
    pre.textContent = `(could not read: ${e.message})`;
  }
  el.append(pre);
  section.append(el);
}

async function projectFiles(slug) {
  const base = `projects/${slug}`;
  return [
    `${base}/state.json`,
    `${base}/log.jsonl`,
    `${base}/refused.jsonl`,
    `${base}/inbox.json`,
    `${base}/views/where-we-left-off.json`,
    `${base}/views/receipts.json`,
    `${base}/views/egress.json`,
  ];
}

async function main() {
  const root = document.getElementById("app");
  root.textContent = "";
  root.append(document.createElement("div")).id = "nav";
  document.getElementById("nav").innerHTML = "<h2>Projects</h2>";
  let index;
  try {
    index = await (await fetch(FILE("projects.json"))).json();
  } catch {
    root.append(document.createTextNode("Could not read projects.json — is the desk shell pointed at a data root?"));
    return;
  }
  const list = document.createElement("ul");
  for (const p of index.projects ?? []) {
    const li = document.createElement("li");
    // An unreadable record is shown as unreadable: it carries no facts, so the page must not print
    // numbers or "undefined" as if they were what the desk knows.
    li.textContent = p.unreadable
      ? `${p.name} (${p.slug}) — unreadable record; refused ${p.refused_count}`
      : `${p.name} (${p.slug}) — last touch ${p.last_touch ?? "none"}, needs ${p.needs ?? 0}, refused ${p.refused_count}`;
    list.append(li);
  }
  root.append(list);

  const files = document.createElement("div");
  root.append(files);
  files.append(Object.assign(document.createElement("h2"), { textContent: `projects.json (today ${index.today})` }));
  files.append(Object.assign(document.createElement("pre"), { textContent: JSON.stringify(index, null, 2) }));

  await show(files, "views/brief.json");
  for (const p of index.projects ?? []) {
    for (const path of await projectFiles(p.slug)) await show(files, path);
  }
}

main();
