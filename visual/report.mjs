// The report: findings by cause and by page, each with a cut-out of its
// screenshot, Claude's suggestion and the person's verdict buttons. Opened as
// a file the buttons copy verdict lines; served by serve.mjs (run.sh report)
// they write them into verdicts.txt.
import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

import { lineOf, targetsOf } from "./verdicts.mjs";

// A run's stamp (20261126-102603, or a folder name that starts with one) as a reader says it.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function when(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(stamp ?? "");
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}, ${m[4]}:${m[5]}` : String(stamp ?? "");
}

const order = { high: 0, medium: 1, low: 2 };
const bySeverity = (a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const badge = (s) => `<span class="sev ${esc(s)}">${esc(s)}</span>`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// A screenshot's size, from its PNG header.
function sizer(out) {
  const sizes = new Map();
  return (shot) => {
    if (!sizes.has(shot)) {
      const header = Buffer.alloc(24);
      const fd = openSync(join(out, shot), "r");
      readSync(fd, header, 0, 24, 0);
      closeSync(fd);
      sizes.set(shot, [header.readUInt32BE(16), header.readUInt32BE(20)]);
    }
    return sizes.get(shot);
  };
}

// Where a finding is: a cut-out of its screenshot with the spot outlined; a
// click shows the whole screenshot with the same mark (the viewer below).
function spot(p, f, sizeOf) {
  const at = f.spots?.[0];
  const r = at && p.records[at.variant];
  if (!r?.shot) return "";
  const [iw, ih] = sizeOf(r.shot);
  const [x, y, w, h] = at.box;
  const pad = 6;
  const s = Math.min(1, 480 / Math.max(w + 2 * pad, 1), 200 / Math.max(h + 2 * pad, 1));
  const W = Math.min(520, Math.round(iw * s));
  const H = Math.min(240, Math.round(ih * s));
  const left = Math.round(Math.min(0, Math.max(W - iw * s, W / 2 - (x + w / 2) * s)));
  const top = Math.round(Math.min(0, Math.max(H - ih * s, H / 2 - (y + h / 2) * s)));
  const mark = `<span class="mark" style="left:${Math.round(left + (x - pad) * s)}px;top:${Math.round(top + (y - pad) * s)}px;width:${Math.round((w + 2 * pad) * s)}px;height:${Math.round((h + 2 * pad) * s)}px"></span>`;
  return `<div class="where"><a class="cut" href="${esc(r.shot)}" data-view="${esc(r.shot)}" data-size="${iw},${ih}" data-mark="${x - pad},${y - pad},${w + 2 * pad},${h + 2 * pad}" title="Whole screenshot (${esc(at.variant)})" style="width:${W}px;height:${H}px"><img loading="lazy" src="${esc(r.shot)}" alt="" style="width:${Math.round(iw * s)}px;left:${left}px;top:${top}px">${mark}</a></div>`;
}

// Claude's suggestion on a finding, or on a cause.
function suggestion(t, causes) {
  if (!t) return "";
  const cause = t.cause && causes[t.cause];
  return `<div class="claude"><span class="chip s-${esc(t.suggest)}">Claude: ${esc(t.suggest)}</span> ${esc(t.why)}${cause ? ` <a class="muted" href="#cause-${esc(t.cause)}">cause: ${esc(cause.title)}</a>` : ""}${t.fixIn ? ` <span class="muted">— fix in ${esc(t.fixIn)}</span>` : ""}</div>`;
}

// The verdict buttons. Agreeing with Claude keeps its reason as the line's comment.
function buttons({ targets, suggest, why }, choices = ["fine", "wrong", "fix"]) {
  return `<span class="verdict" data-targets="${esc(JSON.stringify(targets))}" data-suggest="${esc(suggest ?? "")}" data-why="${esc(oneLine(why))}">${choices
    .map((v) => `<button class="v${v === suggest ? " suggested" : ""}" data-v="${v}" title="${{ fine: "Intended as it is: hide it", wrong: "Grok misread it: hide it and tell Grok", fix: "A real defect: keep it as known until it is gone" }[v]}">${{ fine: "Fine", wrong: "Wrong", fix: "Fix" }[v]}</button>`)
    .join("")}</span>`;
}

const buttonsFor = (f) => buttons({ targets: targetsOf(f), suggest: f.triage?.suggest, why: f.triage?.why }, f.known ? ["fine", "wrong"] : undefined);
const filterTags = (f) => `data-new="${f.isNew ? 1 : 0}" data-suggest="${esc(f.triage?.suggest ?? "none")}"`;

function findingItem(p, f, causes, sizeOf) {
  const variants = f.members.length > 1 ? f.members.map((m) => m.variant).join(", ") : f.variant;
  const others = f.members.slice(1).filter((m) => m.problem !== f.problem || m.quote !== f.quote);
  return `<li id="f-${esc(f.id)}" ${filterTags(f)}>${f.isNew ? `<span class="sev new">new</span> ` : ""}${f.stale ? `<span class="fail">not re-checked</span> ` : ""}${badge(f.severity)} <span class="who">${f.source === "grok" ? "Grok" : "check"}</span> ${esc(f.problem)}${f.quote && f.source === "grok" ? ` <q>${esc(f.quote)}</q>` : ""}${f.where ? ` <span class="muted">— ${esc(f.where)}</span>` : ""} <span class="muted">[${esc(variants)}]</span>${f.source === "grok" && f.onPage === null ? ` <span class="muted">(no text to check)</span>` : ""} ${buttonsFor(f)}${
    others.length ? `<details class="also"><summary class="muted">as found in the other ${plural(others.length, "variant")}</summary><ul>${others.map((m) => `<li class="muted">[${esc(m.variant)}] ${esc(m.problem)}${m.quote ? ` <q>${esc(m.quote)}</q>` : ""}</li>`).join("")}</ul></details>` : ""
  }${f.known && f.decided ? `<div class="muted">Known: ${esc(f.decided)}</div>` : ""}${suggestion(f.triage, causes)}${spot(p, f, sizeOf)}</li>`;
}

function card(row, c) {
  const { p, ai, open, known, hidden, rejected } = row;
  const shots = Object.entries(p.records).filter(([, r]) => r.shot).sort(([a], [b]) => c.reviewed(b) - c.reviewed(a));
  const status = ai?.stale
    ? `<span class="fail">partly not re-checked: Grok failed (see the top)</span>`
    : ai?.skipped
      ? `<span class="warn">partly not reviewed by Grok${c.ai ? " (budget)" : ""}</span>`
      : ai?.fresh
        ? `<span class="muted">reviewed by Grok</span>`
        : ai?.reused
          ? `<span class="muted">review from ${esc(ai.reused.slice(0, 10))}, unchanged</span>`
          : "";
  const hiddenText = [hidden.fine && `${hidden.fine} fine`, hidden.wrong && `${hidden.wrong} wrong`].filter(Boolean).join(", ");
  return `<section class="card page" id="${esc(p.route)}">
  <h3><code>${esc(p.path ?? p.route)}</code> ${status}</h3>
  ${open.length ? `<ul>${open.map((f) => findingItem(p, f, c.causes, c.sizeOf)).join("")}</ul>` : `<p class="muted">No open findings.</p>`}
  ${known.length ? `<details><summary>Known, to fix (${known.length})</summary><ul>${known.map((f) => findingItem(p, f, c.causes, c.sizeOf)).join("")}</ul></details>` : ""}
  ${hiddenText ? `<p class="muted">Hidden by verdicts.txt: ${hiddenText}.</p>` : ""}
  ${rejected.length ? `<details><summary class="muted">${plural(rejected.length, "rejected Grok claim")}</summary><ul>${rejected.map((f) => `<li class="muted">${esc(f.problem)} <q>${esc(f.quote)}</q> [${esc(f.variant)}] — rejected: ${esc(f.rejected ?? "the quoted text is not on the screenshot")}</li>`).join("")}</ul></details>` : ""}
  <div class="shots">${shots.map(([v, r]) => `<a href="${esc(r.shot)}" data-view="${esc(r.shot)}" data-size="${c.sizeOf(r.shot).join(",")}" title="${esc(v)}"><img loading="lazy" src="${esc(r.shot)}" alt="${esc(v)}"><span>${esc(v)}</span></a>`).join("")}</div>
</section>`;
}

const textRow = (f, causes) =>
  `<tr id="f-${esc(f.id)}" ${filterTags(f)}><td>${f.isNew ? `<span class="sev new">new</span> ` : ""}${f.stale ? `<span class="fail">not re-checked</span> ` : ""}${badge(f.severity)} <span class="who">${f.source === "grok" ? "Grok" : "check"}</span></td><td>${esc(f.language)}</td><td><code>${esc(f.ns)}</code><br><code>${esc(f.key)}</code></td><td>${esc(f.current)}</td><td>${esc(f.problem)}${suggestion(f.triage, causes)}</td><td>${esc(f.suggestion)} ${buttonsFor(f)}${f.known && f.decided ? `<div class="muted">Known: ${esc(f.decided)}</div>` : ""}</td></tr>`;
const textTable = (rows, causes) =>
  `<div class="table"><table><tr><th>Severity</th><th>Language</th><th>Key</th><th>Now</th><th>Problem</th><th>Suggestion</th></tr>${rows.map((f) => textRow(f, causes)).join("\n")}</table></div>`;

// Claude's causes, each with the open findings it explains: one decision for all.
function causeSection(all, causes) {
  const members = new Map();
  for (const f of all) if (f.triage?.cause && causes[f.triage.cause]) members.set(f.triage.cause, [...(members.get(f.triage.cause) ?? []), f]);
  if (!members.size) return "";
  const list = [...members.entries()].sort((a, b) => bySeverity(a[1][0], b[1][0]) || b[1].length - a[1].length);
  return `<h2>By cause (${list.length})</h2>
<p class="muted">Claude's grouping of the open findings: a cause's buttons decide all of its findings at once. Each finding is also listed under its page below.</p>
${list
  .map(([id, fs]) => {
    const c = causes[id];
    const where = new Set(fs.map((f) => f.route ?? `${f.ns} (texts)`));
    const targets = [...new Set(fs.flatMap((f) => targetsOf(f)))];
    return `<section class="card cause" id="cause-${esc(id)}" data-members="${esc(fs.map((f) => f.id).join(" "))}">
  <h3>${esc(c.title)} <span class="muted">${plural(fs.length, "finding")} on ${plural(where.size, "page")}</span></h3>
  ${suggestion({ suggest: c.suggest, why: c.why, fixIn: c.fixIn }, {})}
  <p>${buttons({ targets, suggest: c.suggest, why: c.why })}</p>
  <details><summary class="muted">The findings</summary><ul>${fs.map((f) => `<li>${badge(f.severity)} <a href="#f-${esc(f.id)}">${esc(f.route ?? `${f.ns} ${f.key} ${f.language}`)}</a> ${esc(f.problem)}</li>`).join("")}</ul></details>
</section>`;
  })
  .join("\n")}`;
}

function goneSection(gone) {
  if (!gone.length) return "";
  return `<h2>No longer found (${gone.length})</h2>
<p class="muted">Marked "fix" earlier, not found in this run: fixed, most likely. Look, then remove the line.</p>
<div class="card"><ul>${gone.map((v) => `<li><code>${esc(lineOf(v))}</code>${v.why ? ` <span class="muted"># ${esc(v.why)}</span>` : ""} <button class="v remove" data-line="${esc(lineOf(v))}">Fixed: remove the line</button></li>`).join("")}</ul></div>`;
}

const CSS = `:root{--bg:#f6f7f9;--card:#fff;--fg:#1d2330;--muted:#667085;--line:#e3e6eb;--high:#c4320a;--medium:#b54708;--low:#475467;--warn:#b54708;--fix:#c4320a;--fine:#067647;--wrong:#6941c6;--unsure:#475467}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--card:#171b23;--fg:#e6e8ec;--muted:#98a2b3;--line:#2a303b;--high:#f97066;--medium:#fdb022;--low:#98a2b3;--warn:#fdb022;--fix:#f97066;--fine:#47cd89;--wrong:#bd9bff;--unsure:#98a2b3}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px}
h1{font-size:24px;margin:0 0 4px}h2{margin:32px 0 12px;font-size:19px}h3{font-size:15px;margin:0 0 8px;display:flex;gap:12px;flex-wrap:wrap;align-items:baseline}
.muted{color:var(--muted)}.warn{color:var(--warn)}.who{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:0 4px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}
.card ul{margin:0 0 12px;padding-left:18px}.card li{margin:6px 0}
.sev{display:inline-block;min-width:56px;text-align:center;font-size:12px;font-weight:600;border-radius:4px;padding:0 6px;color:#fff;background:var(--low)}
.sev.high{background:var(--high)}.sev.medium{background:var(--medium)}.sev.new{background:#2563eb;min-width:0}.fail{color:var(--high);font-weight:600;font-size:12px}
.alarm{border:2px solid var(--high)}
.claude{margin:4px 0;font-size:14px}.chip{display:inline-block;font-size:12px;font-weight:600;border-radius:4px;padding:0 6px;border:1px solid currentColor}
.s-fix{color:var(--fix)}.s-fine{color:var(--fine)}.s-wrong{color:var(--wrong)}.s-unsure{color:var(--unsure)}
.shots{display:flex;gap:10px;overflow-x:auto;padding-bottom:4px}.shots a{flex:none;text-decoration:none;color:var(--muted);font-size:12px;display:flex;flex-direction:column;gap:4px}
.shots img{height:220px;border:1px solid var(--line);border-radius:6px;object-fit:cover;object-position:top}
.where{margin:6px 0 14px}.cut{display:block;position:relative;overflow:hidden;border:1px solid var(--line);border-radius:6px;background:#fff;max-width:100%}
.cut img{position:absolute;max-width:none}
.mark{position:absolute;border:3px solid #e11d48;border-radius:4px;box-shadow:0 0 0 2px #fff,0 0 0 9999px rgba(0,0,0,.18);pointer-events:none}
.stats{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:14px}
td,th{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600}
.table{overflow-x:auto}details{margin:8px 0}code{font-size:13px;overflow-wrap:anywhere}
.verdict{display:inline-flex;gap:4px;margin-left:4px}
button.v,button.plain{font:inherit;font-size:12px;color:var(--muted);background:none;border:1px solid var(--line);border-radius:4px;padding:0 6px;cursor:pointer}
button.v.suggested{color:var(--fg);border-color:var(--fg);font-weight:600}
.decided{opacity:.45}.decided .verdict::after{content:attr(data-decided);font-size:12px;font-weight:600;margin-left:6px}
.filter{position:sticky;top:0;z-index:5;background:var(--bg);padding:8px 0;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.filter select,.filter button{font:inherit;font-size:14px;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:2px 8px}
.gone-by-filter{display:none}
#marked{position:sticky;bottom:0;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin-top:16px}
#marked textarea{width:100%;box-sizing:border-box;font:12px ui-monospace,monospace;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px}
#viewer{position:fixed;inset:0;z-index:10;background:rgba(10,12,16,.94);overflow:auto;padding:48px 24px}
#viewer[hidden]{display:none}#viewer .frame{position:relative;margin:0 auto}#viewer img{display:block;width:100%;border-radius:6px}
#viewer .bar{position:fixed;top:10px;right:16px;left:16px;display:flex;justify-content:space-between;color:#fff;font-size:13px}
#viewer button{font:inherit;color:#fff;background:rgba(255,255,255,.15);border:0;border-radius:6px;padding:4px 10px;cursor:pointer}`;

// Served (http) a verdict is saved in verdicts.txt at once; opened as a file it
// is collected in the box at the bottom and copied, to paste into verdicts.txt.
const SCRIPT = `
const served = location.protocol.startsWith("http");
const viewer = document.getElementById("viewer");
const frame = viewer.querySelector(".frame");
function view(link) {
  const [iw, ih] = link.dataset.size.split(",").map(Number);
  viewer.hidden = false;
  const width = Math.min(iw, viewer.clientWidth - 48);
  frame.style.width = width + "px";
  frame.querySelector("img").src = link.dataset.view;
  document.getElementById("viewer-name").textContent = link.title;
  const mark = frame.querySelector(".mark");
  mark.hidden = !link.dataset.mark;
  viewer.scrollTop = 0;
  if (link.dataset.mark) {
    const [x, y, w, h] = link.dataset.mark.split(",").map(Number);
    Object.assign(mark.style, { left: (x / iw) * 100 + "%", top: (y / ih) * 100 + "%", width: (w / iw) * 100 + "%", height: (h / ih) * 100 + "%" });
    viewer.scrollTop = Math.max(0, (y + h / 2) * (width / iw) + 48 - viewer.clientHeight / 2);
  }
}
const box = document.getElementById("lines");
async function copy(text) {
  try { await navigator.clipboard.writeText(text); } catch { box.select(); document.execCommand("copy"); }
}
async function save(body) {
  if (served) {
    const r = await fetch("verdicts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) { alert("Not saved: " + (await r.text())); return false; }
    document.getElementById("redraw").hidden = false;
    return true;
  }
  const lines = new Set(box.value.split("\\n").filter(Boolean));
  for (const l of body.lines ?? []) lines.add(l);
  for (const l of body.remove ?? []) lines.add("# remove: " + l);
  box.value = [...lines].join("\\n") + "\\n";
  document.getElementById("marked").hidden = false;
  await copy(box.value);
  return true;
}
function decided(el, verdict) {
  if (!el) return;
  el.classList.add("decided");
  const v = el.querySelector(".verdict");
  if (v) v.dataset.decided = "→ " + verdict;
}
document.addEventListener("click", async (e) => {
  const link = e.target.closest("a[data-view]");
  if (link) { e.preventDefault(); view(link); return; }
  if (!viewer.hidden && (e.target === viewer || e.target.id === "viewer-close")) { viewer.hidden = true; return; }
  const button = e.target.closest("button.v");
  if (!button) return;
  if (button.classList.contains("remove")) {
    if (await save({ remove: [button.dataset.line] })) decided(button.closest("li"), "removed");
    return;
  }
  const holder = button.closest(".verdict");
  const verdict = button.dataset.v;
  const why = verdict === holder.dataset.suggest && holder.dataset.why ? "   # " + holder.dataset.why : "";
  const lines = JSON.parse(holder.dataset.targets).map((t) => verdict + " " + t + why);
  if (!(await save({ lines }))) return;
  const cause = button.closest(".cause");
  decided(cause ?? button.closest("li, tr"), verdict);
  if (cause) for (const id of cause.dataset.members.split(" ")) decided(document.getElementById("f-" + id), verdict);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") viewer.hidden = true; });
document.getElementById("copy").addEventListener("click", () => copy(box.value));
const redraw = document.getElementById("redraw");
redraw.addEventListener("click", async () => {
  redraw.disabled = true;
  redraw.textContent = "Redrawing…";
  const r = await fetch("redraw", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (r.ok) location.reload(); else { alert("Redraw failed: " + (await r.text())); redraw.disabled = false; redraw.textContent = "Redraw"; }
});
// The filter: which open findings to show.
const filter = document.getElementById("filter");
const tests = {
  all: () => true,
  new: (el) => el.dataset.new === "1",
  fix: (el) => el.dataset.suggest === "fix",
  hide: (el) => el.dataset.suggest === "fine" || el.dataset.suggest === "wrong",
  unsure: (el) => el.dataset.suggest === "unsure",
  none: (el) => el.dataset.suggest === "none",
};
function apply() {
  const test = tests[filter.value];
  for (const el of document.querySelectorAll("[data-suggest][id^='f-']")) el.classList.toggle("gone-by-filter", !test(el));
  for (const c of document.querySelectorAll("section.page")) c.classList.toggle("gone-by-filter", filter.value !== "all" && !c.querySelector("li[id^='f-']:not(.gone-by-filter)"));
}
filter.addEventListener("change", apply);
`;

export function renderReport(c) {
  const sizeOf = sizer(c.out);
  const ctx = { ...c, sizeOf };
  const withFindings = c.pageRows.filter((r) => r.open.length || r.known.length).sort((a, b) => bySeverity(a.open[0] ?? a.known[0], b.open[0] ?? b.known[0]));
  const clean = c.pageRows.filter((r) => !r.open.length && !r.known.length);
  const open = [...c.pageRows.flatMap((r) => r.open), ...c.texts.open];
  const tally = (s) => open.filter((f) => (f.triage?.suggest ?? "none") === s).length;
  const knownCount = c.pageRows.reduce((n, r) => n + r.known.length, 0) + c.texts.known.length;
  const grok = c.ai
    ? `Grok (texts: ${esc(c.models.text)}, screenshots: ${esc(c.models.page)}) cost this run: <strong>$${c.spent.toFixed(2)}</strong>${c.maxUsd == null ? "" : ` of ${c.maxUsd}`}`
    : c.redraw
      ? `redrawn without Grok; Grok's earlier reviews shown${c.spent ? `, the run cost $${c.spent.toFixed(2)}` : ""}`
      : "without Grok (AI=0): checks, and Grok's earlier reviews of unchanged screenshots";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Visual review ${esc(when(c.shotAt))}</title>
<style>${CSS}</style></head><body><main>
<h1>Visual review of ${esc(when(c.shotAt))}</h1>
<p class="muted">Screenshots taken ${esc(when(c.shotAt))}${c.stamp && c.stamp !== c.shotAt ? `, reviewed ${esc(when(c.stamp))}` : ""} · commit <code>${esc(c.commit.split(" ")[0])}</code> ${esc(c.commit.split(" ").slice(1).join(" "))}</p>
<p class="muted">${c.pageTotal} pages, ${c.variantTotal} variants · ${grok}</p>
<div class="stats">
${c.since ? `<div class="stat"><span class="sev new">new</span> since ${esc(c.since)}: ${c.newPages} on pages, ${c.newTexts} in texts</div>` : ""}
<div class="stat">Pages: ${badge("high")} ${c.pageCount.high} ${badge("medium")} ${c.pageCount.medium} ${badge("low")} ${c.pageCount.low}</div>
<div class="stat">Texts: ${badge("high")} ${c.textCount.high} ${badge("medium")} ${c.textCount.medium} ${badge("low")} ${c.textCount.low}</div>
<div class="stat">Claude suggests: <span class="s-fix">${tally("fix")} fix</span> · <span class="s-fine">${tally("fine")} fine</span> · <span class="s-wrong">${tally("wrong")} wrong</span> · ${tally("unsure")} unsure · ${tally("none")} not triaged</div>
<div class="stat">Known, to fix: ${knownCount}${c.gone.length ? ` · no longer found: ${c.gone.length}` : ""}</div>
</div>
${c.failures.length ? `<div class="card alarm"><strong class="fail" style="font-size:16px">Grok could not review ${esc(c.failureSummary)}.</strong>
<p>xAI answered: <code>${esc(c.failures[0].error.slice(0, 300))}</code></p>
<p>Where there were earlier results, they are shown, marked "not re-checked". After fixing the cause (often a model xAI no longer serves: <code>TEXT_MODEL</code> / <code>PAGE_MODEL</code>), <code>.grok-bot/run.sh visual-review</code> reviews just these again.</p></div>` : ""}
${c.notes.length ? `<div class="card"><strong>Notes</strong><ul>${c.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>` : ""}
<p class="muted">Your verdict on each finding: <strong>Fine</strong> (intended: hidden from now on), <strong>Wrong</strong> (Grok misread the screenshot: hidden, and Grok is told), <strong>Fix</strong> (a real defect: kept as known until it is gone). The outlined button is Claude's suggestion; agreeing keeps its reason in <code>verdicts.txt</code>. Served by <code>.grok-bot/run.sh report</code> the buttons save at once; opened as a file they copy lines to paste into <code>.grok-bot/verdicts.txt</code>.</p>
<p class="muted">"check" findings are measured in the browser and reliable. "Grok" findings are its reading of one screenshot; the text each one quotes was found on that screenshot, but the judgement can still be wrong: look before acting.</p>
<div class="filter"><label for="filter">Show</label><select id="filter"><option value="all">all findings</option><option value="new">new since the previous run</option><option value="fix">Claude suggests fix</option><option value="hide">Claude suggests fine or wrong</option><option value="unsure">Claude is unsure</option><option value="none">not triaged by Claude</option></select><button id="redraw" hidden>Redraw with the new verdicts</button></div>
${causeSection(open, c.causes)}
${goneSection(c.gone)}
<h2>Pages with findings (${withFindings.length})</h2>
${withFindings.map((r) => card(r, ctx)).join("\n")}
<details><summary>Pages without findings (${clean.length})</summary>${clean.map((r) => card(r, ctx)).join("\n")}</details>
${c.notReached.length ? `<details><summary>Routes the sweep found no example for (${c.notReached.length})</summary><ul>${c.notReached.map((r) => `<li><code>${esc(r)}</code></li>`).join("")}</ul></details>` : ""}
<h2>Texts (${c.texts.open.length})</h2>
${textTable(c.texts.open, c.causes)}
${c.texts.known.length ? `<details><summary>Known, to fix (${c.texts.known.length})</summary>${textTable(c.texts.known, c.causes)}</details>` : ""}
<div id="marked" hidden><strong>Verdicts</strong> <span class="muted">— copied; paste into <code>.grok-bot/verdicts.txt</code> (a new line about the same finding replaces the old one: delete that one)</span>
<textarea id="lines" rows="4" readonly></textarea><button class="plain" id="copy">Copy again</button></div>
<div id="viewer" hidden><div class="bar"><span id="viewer-name"></span><button id="viewer-close">Close (Esc)</button></div><div class="frame"><img alt=""><span class="mark"></span></div></div>
<script>${SCRIPT}</script>
</main></body></html>`;
}
