// Turns a sweep (sweep.spec.ts) into a report: the automatic checks, free
// checks of the German and Spanish texts, then Grok on the screenshots and
// the texts, within a budget. Pages and texts that did not change since
// their last review keep that review and cost nothing.
//
// Reads /out/sweep, /out/shots, /src (the app's texts) and /state; writes
// /out/report.html, /out/findings.json and /state/visual-state.json.
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const OUT = process.env.REVIEW_OUT ?? "/out";
const SRC = process.env.REVIEW_SRC ?? "/src";
const STATE = process.env.REVIEW_STATE ?? "/state/visual-state.json";
const AI = process.env.AI !== "0" && Boolean(process.env.XAI_API_KEY);
// Texts: the coding model is good enough and cheaper. Screenshots: the
// strongest Grok model for images (Roboflow vision evals, Nov 2026).
const TEXT_MODEL = process.env.TEXT_MODEL || "grok-build-0.1";
const PAGE_MODEL = process.env.PAGE_MODEL || process.env.REVIEW_MODEL || "grok-4.7";
const MAX_USD = Number(process.env.MAX_USD || 2);
const FULL = process.env.FULL === "1";
// USD per million tokens (input, cached input, output) below 200k tokens per
// request, from docs.x.ai pricing; used when xAI does not state a request's cost.
const PRICES = { "grok-build-0.1": [1, 0.2, 2], "grok-4.7": [2, 0.5, 6], "grok-4.6": [2, 0.5, 6], "grok-4.5": [2, 0.3, 6], "grok-4.3": [1.25, 0.2, 2.5] };
function priceOf(model) {
  const [i, c, o] = PRICES[model] ?? [process.env.PRICE_IN || 2, process.env.PRICE_CACHED || 0.5, process.env.PRICE_OUT || 6].map(Number);
  return { in: i, cached: c, out: o };
}
// REVIEW_VARIANTS: which screenshots Grok reviews now, by name or part of a
// name ("tablet", "en-wide-light"). Reviews from earlier runs of other
// variants stay in the report either way.
const REVIEW_TOKENS = (process.env.REVIEW_VARIANTS || "en-desktop-light en-phone-light en-desktop-dark de-phone-light es-phone-light").split(/\s+/).filter(Boolean);
const reviewed = (v) => REVIEW_TOKENS.includes("all") || REVIEW_TOKENS.some((w) => v.includes(w));
const PARALLEL = 3;
const LANGS = ["en", "de", "es"];

const describe = {
  "en-desktop-light": "English, desktop 1440 px, light theme",
  "en-desktop-dark": "English, desktop 1440 px, dark theme",
  "en-phone-light": "English, phone 390 px, light theme",
  "en-phone-dark": "English, phone 390 px, dark theme",
  "de-desktop-light": "German, desktop 1440 px, light theme",
  "de-phone-light": "German, phone 390 px, light theme",
  "es-desktop-light": "Spanish, desktop 1440 px, light theme",
  "es-phone-light": "Spanish, phone 390 px, light theme",
  "en-tablet-light": "English, tablet 820 px, light theme",
  "en-tablet-dark": "English, tablet 820 px, dark theme",
  "de-tablet-light": "German, tablet 820 px, light theme",
  "es-tablet-light": "Spanish, tablet 820 px, light theme",
  "en-wide-light": "English, large desktop 1920 px, light theme",
  "en-wide-dark": "English, large desktop 1920 px, dark theme",
  "de-wide-light": "German, large desktop 1920 px, light theme",
  "es-wide-light": "Spanish, large desktop 1920 px, light theme",
  "en-qhd-light": "English, large desktop 2560 px, light theme",
  "en-qhd-dark": "English, large desktop 2560 px, dark theme",
};

// ---------------------------------------------------------------- inputs
const sweepDir = join(OUT, "sweep");
const sweeps = existsSync(sweepDir)
  ? readdirSync(sweepDir).filter((f) => f.endsWith(".json")).map((f) => ({ variant: f.slice(0, -5), records: JSON.parse(readFileSync(join(sweepDir, f), "utf8")) }))
  : [];
const pages = new Map(); // route -> { route, path, records: { variant: record } }
for (const { variant, records } of sweeps)
  for (const r of records) {
    const p = pages.get(r.route) ?? { route: r.route, path: r.path, records: {} };
    p.path ??= r.path;
    p.records[variant] = r;
    pages.set(r.route, p);
  }

function localeFiles(dir, found = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) localeFiles(path, found);
    else if (/\/locales\/(?:[\w-]+\.)?(en|de|es)\.json$/.test(path)) found.push(path);
  }
  return found;
}
function flatten(value, prefix, into) {
  if (typeof value === "string") into[prefix] = value;
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, into);
  return into;
}
const namespaces = new Map(); // ns -> { en: {key: text}, de, es, raw: text for hashing }
for (const file of localeFiles(SRC).sort()) {
  const [, prefix, lang] = /\/locales\/(?:([\w-]+)\.)?(en|de|es)\.json$/.exec(file);
  const ns = relative(SRC, dirname(dirname(file))) + (prefix ? `/${prefix}` : "");
  const entry = namespaces.get(ns) ?? { en: {}, de: {}, es: {}, raw: "" };
  const raw = readFileSync(file, "utf8");
  entry[lang] = flatten(JSON.parse(raw), "", {});
  entry.raw += raw;
  namespaces.set(ns, entry);
}

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { pages: {}, texts: {} };
const saveState = () => writeFileSync(STATE, JSON.stringify(state, null, 1));
const hash = (data) => createHash("sha256").update(data).digest("hex").slice(0, 16);

// ---------------------------------------------------------------- automatic checks (free)
const auto = new Map(); // route -> findings
for (const p of pages.values()) {
  const found = [];
  for (const [variant, r] of Object.entries(p.records)) {
    const add = (severity, problem, at = {}) => found.push({ variant, severity, problem, source: "check", ...at });
    const item = (t) => (typeof t === "string" ? { text: t } : t);
    const lang = variant.slice(0, 2);
    if (r.notReached) continue;
    if (r.failed) add("high", `The page did not load: ${r.failed}`);
    if (r.overflowX) add(variant.includes("phone") ? "high" : "medium", `The page scrolls sideways by ${r.overflowX} px.`);
    for (const t of r.rawKeys ?? []) add("high", `A raw text key is shown instead of a text: "${t}"`, { quote: t });
    for (const t of r.placeholders ?? []) add("high", `An unfilled placeholder is shown: "${t}"`, { quote: t });
    for (const t of r.english ?? []) add("medium", `English text on the ${lang === "de" ? "German" : "Spanish"} page: "${t}"`, { quote: t });
    for (const t of (r.clipped ?? []).map(item)) add("low", `Text may be cut off (${t.text})`, { box: t.box });
    for (const t of (r.squeezed ?? []).map(item)) add("medium", `Text squeezed into a narrow column: ${t.text}`, { box: t.box });
    for (const t of r.consoleErrors ?? []) add("medium", `Console error: ${t}`);
    if (lang !== "en" && r.lang && r.lang !== lang) add("low", `The page stayed in "${r.lang}": the language could not be switched here, so this variant does not show ${lang}.`);
  }
  // The same finding in several variants once, naming them all.
  const merged = new Map();
  for (const f of found) {
    const m = merged.get(f.problem) ?? { ...f, variant: [], spots: [] };
    m.variant.push(f.variant);
    if (f.box) m.spots.push({ variant: f.variant, box: f.box });
    merged.set(f.problem, m);
  }
  auto.set(p.route, [...merged.values()].map(({ box, ...f }) => ({ ...f, variant: f.variant.join(", ") })));
}
const notReached = [...pages.values()].filter((p) => Object.values(p.records).every((r) => r.notReached)).map((p) => p.route);

// ---------------------------------------------------------------- text checks (free)
const placeholders = (s) => [...(s.match(/\{\{\s*[\w.]+\s*\}\}/g) ?? [])].map((x) => x.replace(/\s/g, "")).sort().join(" ");
const informal = { de: /\b(du|dich|dein|deine|deinen|deinem|deiner|deines|euch|euer|eure)\b/i, es: /\b(tú|tus|contigo|ti)\b|\btu\s+\p{L}/iu };
// Product names ("CrowdStrike Falcon") and labels ("Asset {{name}}") are the
// same in every language; a sentence has ordinary lowercase words.
const looksLikeProse = (s) => {
  const words = s.replace(/\{\{[^}]*\}\}/g, " ").split(/[^\p{L}']+/u).filter(Boolean);
  return words.length >= 2 && words.filter((w) => /^\p{Ll}{3,}$/u.test(w)).length >= 2;
};
const textChecks = new Map(); // ns -> findings
for (const [ns, t] of namespaces) {
  const found = [];
  for (const [key, en] of Object.entries(t.en))
    for (const lang of ["de", "es"]) {
      const add = (severity, problem) => found.push({ key, language: lang, severity, problem, source: "check" });
      const tr = t[lang][key];
      if (tr === undefined) {
        add("high", "Missing.");
        continue;
      }
      if (placeholders(tr) !== placeholders(en)) add("high", `Placeholders differ from English (${placeholders(en) || "none"} vs ${placeholders(tr) || "none"}).`);
      if (tr === en && looksLikeProse(en)) add("low", `Same as the English text: "${en.slice(0, 120)}"`);
      if (informal[lang].test(tr)) add("medium", `May address the reader informally (${lang === "de" ? "Sie" : "usted"} expected): "${tr.slice(0, 120)}"`);
    }
  textChecks.set(ns, found);
}

// ---------------------------------------------------------------- Grok
let api = "responses";
let spent = 0;
let reserved = 0;
let calls = 0;
let imageTokens = 2500; // a first guess; measured on the first page
const notes = [];

// accepted.txt: findings that are fine as they are. They are hidden from the
// report and named to Grok so it does not raise them again.
//   page <route> "<quoted text, or the finding's words>"   # why
//   text <namespace> <key> <de|es>                          # why
const ACCEPTED = process.env.REVIEW_ACCEPTED ?? "/accepted.txt";
const accepted = { page: [], text: [] };
if (existsSync(ACCEPTED))
  for (const raw of readFileSync(ACCEPTED, "utf8").split("\n")) {
    const line = raw.trim();
    let m;
    if (!line || line.startsWith("#")) continue;
    if ((m = /^page\s+(\S+)\s+"((?:[^"\\]|\\.)*)"/.exec(line))) accepted.page.push({ route: m[1], text: m[2].replace(/\\(.)/g, "$1") });
    else if ((m = /^text\s+(\S+)\s+(\S+)\s+(de|es)\b/.exec(line))) accepted.text.push({ ns: m[1], key: m[2], language: m[3] });
    else notes.push(`accepted.txt: this line could not be read: ${line}`);
  }
// review-notes.md: what the person wants Grok to know about the product.
const NOTES = process.env.REVIEW_NOTES ?? "/notes.md";
const houseNotes = existsSync(NOTES)
  ? readFileSync(NOTES, "utf8").split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).join("\n").trim()
  : "";
const notesBlock = houseNotes ? `\nNotes from the product's owner (they decide what is intended):\n${houseNotes}\n` : "";
const acceptedFor = (route) => accepted.page.filter((a) => a.route === route).map((a) => a.text);
const keyOf = (f) => (f.quote && String(f.quote).trim() ? f.quote : f.problem);
const pageLine = (route, f) => `page ${route} "${String(keyOf(f)).replace(/\s+/g, " ").replace(/["\\]/g, "\\$&")}"`;
const textLine = (f) => `text ${f.ns} ${f.key} ${f.language}`;
function pageAccepted(route, f) {
  return accepted.page.some((a) => {
    if (a.route !== route) return false;
    const t = norm(a.text);
    return t === norm(keyOf(f)) || (t.length >= 6 && (norm(f.quote).includes(t) || norm(f.problem).includes(t)));
  });
}
const textAccepted = (f) => accepted.text.some((a) => a.ns === f.ns && a.key === f.key && a.language === f.language);

async function send(model, text, images, maxOut) {
  const responses = api === "responses";
  const content = responses
    ? [{ type: "input_text", text }, ...images.map((url) => ({ type: "input_image", image_url: url, detail: "high" }))]
    : [{ type: "text", text }, ...images.map((url) => ({ type: "image_url", image_url: { url, detail: "high" } }))];
  const body = responses
    ? { model, input: [{ role: "user", content }], max_output_tokens: maxOut, store: false }
    : { model, messages: [{ role: "user", content }], max_tokens: maxOut };
  const res = await fetch(`https://api.x.ai/v1/${responses ? "responses" : "chat/completions"}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = `${res.status} ${JSON.stringify(data).slice(0, 400)}`;
    if (responses && calls === 0 && [400, 404, 405, 422].includes(res.status)) {
      notes.push(`The Responses API answered ${error}; using Chat Completions.`);
      api = "chat";
      return send(model, text, images, maxOut);
    }
    return { ok: false, retry: res.status === 429 || res.status >= 500, error };
  }
  calls++;
  const u = data.usage ?? {};
  const input = u.input_tokens ?? u.prompt_tokens ?? 0;
  const cached = u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoning = u.output_tokens_details?.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens ?? 0;
  let output = responses ? (u.output_tokens ?? 0) : (u.completion_tokens ?? 0) + reasoning;
  if (responses && reasoning > output) output += reasoning;
  const ticks = u.cost_in_usd_ticks ?? data.cost_in_usd_ticks;
  const price = priceOf(model);
  const cost = ticks != null ? ticks / 1e10 : ((input - cached) * price.in + cached * price.cached + output * price.out) / 1e6;
  spent += cost;
  const answer = responses
    ? (data.output ?? []).flatMap((o) => o.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text).join("")
    : (data.choices?.[0]?.message?.content ?? "");
  return { ok: true, answer, input, cost };
}

async function ask(model, text, images = [], maxOut = 4000) {
  for (let attempt = 0; ; attempt++) {
    const r = await send(model, text, images, maxOut).catch((e) => ({ ok: false, retry: true, error: String(e) }));
    if (r.ok || !r.retry || attempt >= 3) return r;
    await new Promise((done) => setTimeout(done, 3000 * 2 ** attempt));
  }
}

function findingsOf(answer) {
  const a = answer.indexOf("{");
  const b = answer.lastIndexOf("}");
  try {
    const list = JSON.parse(answer.slice(a, b + 1)).findings;
    return Array.isArray(list) ? list : [];
  } catch {
    return [{ severity: "low", problem: `Grok's answer could not be read: ${answer.slice(0, 300)}` }];
  }
}

// Runs jobs a few at a time while the budget allows each one's estimate.
async function within(jobs, estimate, run) {
  const skipped = [];
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next++];
      const cost = estimate(job);
      if (spent + reserved + cost > MAX_USD) {
        skipped.push(job);
        continue;
      }
      reserved += cost;
      try {
        await run(job);
      } finally {
        reserved -= cost;
      }
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  return skipped;
}

const glossary = `Rules for the German and Spanish texts of this product:
- German addresses the reader formally ("Sie"), Spanish too ("usted").
- The product is "the AI SOC" (de "der AI SOC", es "el AI SOC").
- Workspace: de "Workspace", es "espacio de trabajo". Finding: de "Finding", es "hallazgo". Case: de "Fall", es "caso".
- Role names are roles, not people: de "Analyst", "Betrachter", without gender forms.
- Internal names (SOC core, queue subjects, raw slugs, IDs) never appear in texts.
- {{placeholders}} stay exactly as in English; keys ending _one/_other are plural forms.`;

const textPrompt = (ns, t) => `You review the German (de) and Spanish (es) user interface texts of a B2B security product (an AI-assisted SOC) against the English (en) source.

${glossary}
${notesBlock}
Report real problems only: wrong or missing meaning, English left untranslated, informal address, glossary violations, grammar or spelling errors, wrong plural forms, terms used inconsistently, and wording a native speaker would find clearly unnatural. Do not report matters of taste. At most 40 findings, most important first.

Answer with JSON only:
{"findings":[{"key":"<key>","language":"de|es","severity":"high|medium|low","problem":"<what is wrong, in English>","suggestion":"<better text>"}]}

Namespace: ${ns}
en: ${JSON.stringify(t.en)}
de: ${JSON.stringify(t.de)}
es: ${JSON.stringify(t.es)}`;

const languageName = { en: "English", de: "German", es: "Spanish" };
const pagePrompt = (p, v) => `You review one screenshot of one page of a B2B security web app (an AI-assisted SOC). Page: ${p.path}
This screenshot: ${describe[v] ?? v}. Its interface language is ${languageName[v.slice(0, 2)]}.
${notesBlock}
The data shown is fake sample data and is never a finding: titles of cases and findings, names of people, customers, workspaces, sites and devices, hostnames, IP addresses, counts, dates and times of events. Product terms that stay English in German and Spanish texts: AI SOC, Workspace (German), Finding (German), Status (German), STIX, MITRE, ATT&CK.

Report what a careful designer and tester would flag in THIS screenshot: overlapping or cut-off text, broken or misaligned layout, elements outside their box or the screen, controls too small or crowded on a phone, unreadable contrast, areas that look empty or broken, raw keys or {{placeholders}}, interface labels not in ${languageName[v.slice(0, 2)]}, text that wraps badly. Only what you can see in this image, nothing you are not sure of, nothing you expect to be elsewhere on the page.

Also report text squeezed into a narrow column while the space beside it stays empty, and other wasted or unbalanced space that makes a layout look broken.

Not defects, do not report: an empty state that says so in words (for example "no score"); hints under form fields; the bottom edge of the screenshot (it is cut there on purpose); a long line wrapping across the full available width; a label next to its value; legends, icons and design choices you merely find unusual. Report only what you would file as a bug with confidence. No findings is a good answer.
${acceptedFor(p.route).length ? `\nAlready reviewed and fine as it is, do not report again:\n${acceptedFor(p.route).map((t) => `- "${t}"`).join("\n")}\n` : ""}
For every finding, "quote" is the exact text in the screenshot the finding is about, copied character for character. For a problem that involves no text (for example two boxes overlapping), quote the text nearest to it, so its place can be marked. Findings are checked against the page's real text; a quote that is not there is discarded.

Answer with JSON only; an empty list if the screenshot looks fine:
{"findings":[{"severity":"high|medium|low","problem":"<what is wrong>","where":"<where on the screen>","quote":"<exact text or empty>"}]}`;

const textsOf = (r) => r.texts ?? r.boxes?.map((b) => b[0]);

// Where a quoted text stands on a screenshot: its first place, or, for a
// quote that runs over several pieces of text, those pieces together.
function locate(quote, boxes) {
  const q = norm(quote);
  if (!q || !boxes?.length) return null;
  const whole = boxes.find((b) => norm(b[0]).includes(q));
  if (whole) return whole.slice(1);
  const parts = boxes.filter((b) => b[0].length >= 4 && q.includes(norm(b[0])));
  if (!parts.length) return null;
  const near = parts.filter((b) => Math.abs(b[2] - parts[0][2]) < 300);
  const x = Math.min(...near.map((b) => b[1]));
  const y = Math.min(...near.map((b) => b[2]));
  return [x, y, Math.max(...near.map((b) => b[1] + b[3])) - x, Math.max(...near.map((b) => b[2] + b[4])) - y];
}

// Whether Grok's quote is text of that screenshot: true, false, or null when there is no quote to check.
const norm = (x) => String(x ?? "").toLowerCase().replace(/[\s\u00ad]+/g, " ").replace(/^[\s"'„“”«»‚‘’]+|[\s"'„“”«»‚‘’.…]+$/g, "");
function quoted(quote, texts) {
  const q = norm(quote);
  if (!q || !texts) return null;
  const all = texts.map(norm);
  return all.some((t) => t.includes(q) || (t.length >= 8 && q.includes(t))) || all.join(" ").includes(q);
}

const REVIEW_VERSION = 4; // raising it makes every screenshot be reviewed again
const aiPages = new Map(); // route -> { findings, reused, skipped }
function addPage(route, part) {
  const page = aiPages.get(route) ?? { findings: [] };
  page.findings.push(...part.findings);
  if (part.reused) page.reused = page.reused && page.reused < part.reused ? page.reused : part.reused;
  if (part.skipped) page.skipped = true;
  if (!part.reused && !part.skipped) page.fresh = true;
  aiPages.set(route, page);
}
const aiTexts = new Map(); // ns -> { findings, reused, skipped }

if (AI) {
  // Texts first: cheap and complete.
  const textJobs = [];
  for (const [ns, t] of namespaces) {
    const h = hash(t.raw);
    const prev = state.texts[ns];
    if (!FULL && prev?.hash === h) aiTexts.set(ns, { findings: prev.findings, reused: prev.at });
    else textJobs.push({ ns, t, h });
  }
  const textEstimate = (j) => ((textPrompt(j.ns, j.t).length / 3) * priceOf(TEXT_MODEL).in + 4000 * priceOf(TEXT_MODEL).out) / 1e6;
  console.log(`Texts: ${textJobs.length} namespaces to review, ${namespaces.size - textJobs.length} unchanged`);
  const textSkipped = await within(textJobs, textEstimate, async (j) => {
    const r = await ask(TEXT_MODEL, textPrompt(j.ns, j.t), [], 6000);
    if (!r.ok) {
      notes.push(`Texts ${j.ns}: ${r.error}`);
      return;
    }
    const findings = findingsOf(r.answer).map((f) => ({ ...f, source: "grok" }));
    aiTexts.set(j.ns, { findings });
    state.texts[j.ns] = { hash: j.h, findings, at: new Date().toISOString() };
    saveState();
    console.log(`  ${j.ns}: ${findings.length} findings ($${r.cost.toFixed(3)})`);
  });
  for (const j of textSkipped) aiTexts.set(j.ns, { findings: [], skipped: true });

  // Then the pages: one screenshot per request, so findings cannot drift between images.
  const pageJobs = [];
  let unchanged = 0;
  for (const p of pages.values())
    for (const [v, r] of Object.entries(p.records)) {
      if (!r?.shot) continue;
      const image = readFileSync(join(OUT, r.shot));
      const h = hash(Buffer.concat([Buffer.from(`review ${REVIEW_VERSION} ${PAGE_MODEL}`), image]));
      const id = `${p.route} ${v}`;
      const prev = state.pages[id];
      if (!FULL && prev?.hash === h) {
        unchanged++;
        addPage(p.route, { findings: prev.findings, reused: prev.at });
      } else if (reviewed(v)) pageJobs.push({ p, v, r, image, h, id });
    }
  const pageEstimate = () => ((imageTokens + 1100) * priceOf(PAGE_MODEL).in + 1500 * priceOf(PAGE_MODEL).out) / 1e6;
  console.log(`Screenshots: ${pageJobs.length} to review, ${unchanged} unchanged since their last review`);
  let measured = false;
  const runPage = async (j) => {
    const prompt = pagePrompt(j.p, j.v);
    const r = await ask(PAGE_MODEL, prompt, [`data:image/png;base64,${j.image.toString("base64")}`], 4000);
    if (!r.ok) {
      notes.push(`${j.p.route} ${j.v}: ${r.error}`);
      return;
    }
    if (!measured) {
      measured = true;
      imageTokens = Math.max(100, Math.round(r.input - prompt.length / 3));
      const each = pageEstimate();
      console.log(`  A screenshot counts as about ${imageTokens} tokens, about $${each.toFixed(4)} with its prompt; all ${pageJobs.length} about $${(each * pageJobs.length).toFixed(2)} (budget left $${(MAX_USD - spent).toFixed(2)})`);
    }
    const findings = findingsOf(r.answer).map((f) => ({ ...f, variant: j.v, source: "grok", onPage: quoted(f.quote, textsOf(j.r)) }));
    addPage(j.p.route, { findings });
    state.pages[j.id] = { hash: j.h, findings, at: new Date().toISOString() };
    saveState();
    const kept = findings.filter((f) => f.onPage !== false).length;
    console.log(`  ${j.p.path} ${j.v}: ${kept} findings${findings.length > kept ? `, ${findings.length - kept} rejected` : ""} ($${r.cost.toFixed(3)})`);
  };
  const [first, ...rest] = pageJobs;
  const skipped = first ? await within([first], pageEstimate, runPage) : [];
  skipped.push(...(await within(rest, pageEstimate, runPage)));
  for (const j of skipped) addPage(j.p.route, { findings: [], skipped: true });
  if (skipped.length) notes.push(`${skipped.length} screenshots were not reviewed: the budget of $${MAX_USD} was reached. Raise it with MAX_USD=…; the next run reviews them first.`);
}

// ---------------------------------------------------------------- report
const order = { high: 0, medium: 1, low: 2 };
const bySeverity = (a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const badge = (s) => `<span class="sev ${esc(s)}">${esc(s)}</span>`;

// Judges each Grok finding against its screenshot's real text, also those
// reused from earlier runs, so a stricter rule costs no new review.
// A claim that text is English must quote whole words on the page ("Edit" in
// "Editar" is not), and is wrong when the quote is exactly that language's own
// translation in the app's text files ("Assets" in German).
const translations = Object.fromEntries(
  ["de", "es"].map((l) => [l, new Set([...namespaces.values()].flatMap((t) => Object.values(t[l])).map(norm))]),
);
const languageClaim = /\b(english|untranslated|not translated|not locali[sz]ed)\b/i;
const wholeWords = (quote, texts) => {
  const q = norm(quote).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const words = new RegExp(`(?<![\\p{L}\\p{N}])${q}(?![\\p{L}\\p{N}])`, "u");
  return (texts ?? []).some((t) => words.test(norm(t)));
};
function judge(p, f) {
  if (f.source !== "grok") return f;
  const texts = textsOf(p.records[f.variant] ?? {});
  const onPage = texts ? quoted(f.quote, texts) : f.onPage;
  if (onPage === false) return { ...f, onPage, rejected: "the quoted text is not on the screenshot" };
  const lang = String(f.variant).slice(0, 2);
  if (onPage && languageClaim.test(f.problem) && lang !== "en") {
    if (!wholeWords(f.quote, texts)) return { ...f, onPage: false, rejected: "the quote is only part of a word on the screenshot" };
    if (translations[lang]?.has(norm(f.quote)))
      return { ...f, onPage: false, rejected: `the ${lang === "de" ? "German" : "Spanish"} text file has exactly this text: it is the intended translation` };
  }
  return { ...f, onPage };
}

// New since the previous run: findings that run's findings.json does not hold.
// A page finding is known by its route, source and quote (or wording), a text
// finding by its key and language; Grok's wording may change, its quote rarely.
const PREVIOUS = process.env.REVIEW_PREVIOUS ?? "/previous.json";
const previous = existsSync(PREVIOUS) ? JSON.parse(readFileSync(PREVIOUS, "utf8")) : null;
const pageKey = (route, f) => [route, f.source, f.source === "grok" ? f.variant : "", norm(f.quote || f.problem)].join("|");
const textKey = (f) => [f.ns, f.key, f.language, f.source].join("|");
const known = new Set([
  ...(previous?.pages ?? []).flatMap((p) => p.findings.map((f) => pageKey(p.route, f))),
  ...(previous?.texts ?? []).map(textKey),
]);
const isNew = (key) => Boolean(previous) && !known.has(key);

const pageRows = [...pages.values()].map((p) => {
  const ai = aiPages.get(p.route);
  const judged = (ai?.findings ?? []).map((f) => judge(p, f));
  const all = [...(auto.get(p.route) ?? []), ...judged.filter((f) => f.onPage !== false)];
  const findings = all.filter((f) => !pageAccepted(p.route, f)).sort(bySeverity);
  const rejected = judged.filter((f) => f.onPage === false);
  return { p, ai, findings: findings.map((f) => ({ ...f, isNew: isNew(pageKey(p.route, f)) })), rejected, accepted: all.length - findings.length };
});
const rejectedCount = pageRows.reduce((n, r) => n + r.rejected.length, 0);
if (rejectedCount) notes.push(`${rejectedCount} of Grok's screenshot findings were rejected against the page's real text (each says why). They are listed, collapsed, under their page.`);
// Grok's text findings that name no real key, or suggest the text as it already is, are dropped.
let droppedTexts = 0;
const realText = (ns, f) => {
  const current = namespaces.get(ns)?.[f.language]?.[f.key];
  const ok = current !== undefined && (!f.suggestion || String(f.suggestion).trim() !== current.trim());
  if (!ok) droppedTexts++;
  return ok;
};
const textRows = [...namespaces.keys()].flatMap((ns) =>
  [...(textChecks.get(ns) ?? []), ...(aiTexts.get(ns)?.findings ?? []).filter((f) => realText(ns, f))].map((f) => ({ ns, ...f, current: namespaces.get(ns)?.[f.language]?.[f.key] })),
).filter((f) => !textAccepted(f)).map((f) => ({ ...f, isNew: isNew(textKey(f)) })).sort(bySeverity);
if (accepted.page.length + accepted.text.length) notes.push(`${accepted.page.length + accepted.text.length} lines in accepted.txt; findings matching them are hidden.`);
if (droppedTexts) notes.push(`${droppedTexts} of Grok's text findings were dropped: they name a key that does not exist in that language, or suggest the current text unchanged.`);
const count = (list) => Object.fromEntries(["high", "medium", "low"].map((s) => [s, list.filter((f) => f.severity === s).length]));
const pageCount = count(pageRows.flatMap((r) => r.findings));
const textCount = count(textRows);
const newPages = pageRows.reduce((n, r) => n + r.findings.filter((f) => f.isNew).length, 0);
const newTexts = textRows.filter((f) => f.isNew).length;
const sinceName = previous?.stamp ?? process.env.PREVIOUS_NAME;
const since = sinceName ? `the run of ${sinceName}` : "the previous run";

writeFileSync(join(OUT, "findings.json"), JSON.stringify({ stamp: process.env.STAMP, pages: pageRows.map((r) => ({ route: r.p.route, path: r.p.path, findings: r.findings })), texts: textRows, spent, notes }, null, 1));

// A screenshot's size, from its PNG header.
const sizes = new Map();
function sizeOf(shot) {
  if (!sizes.has(shot)) {
    const header = Buffer.alloc(24);
    const fd = openSync(join(OUT, shot), "r");
    readSync(fd, header, 0, 24, 0);
    closeSync(fd);
    sizes.set(shot, [header.readUInt32BE(16), header.readUInt32BE(20)]);
  }
  return sizes.get(shot);
}

// Where a finding is: a cut-out of its screenshot with the spot outlined; a
// click shows the whole screenshot with the same mark (the viewer below).
function spotOf(p, f) {
  if (f.spots?.length) return f.spots[0];
  const variant = String(f.variant ?? "").split(",")[0].trim();
  const r = p.records[variant];
  const box = locate(f.quote, r?.boxes);
  return box ? { variant, box } : null;
}
function spot(p, f) {
  const at = spotOf(p, f);
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
  const mark = (unit, l, t, mw, mh) => `<span class="mark" style="left:${l}${unit};top:${t}${unit};width:${mw}${unit};height:${mh}${unit}"></span>`;
  const pct = (v, of) => ((v / of) * 100).toFixed(2);
  return `<div class="where">
    <a class="cut" href="${esc(r.shot)}" data-view="${esc(r.shot)}" data-size="${iw},${ih}" data-mark="${x - pad},${y - pad},${w + 2 * pad},${h + 2 * pad}" title="Whole screenshot (${esc(at.variant)})" style="width:${W}px;height:${H}px"><img loading="lazy" src="${esc(r.shot)}" alt="" style="width:${Math.round(iw * s)}px;left:${left}px;top:${top}px">${mark("px", Math.round(left + (x - pad) * s), Math.round(top + (y - pad) * s), Math.round((w + 2 * pad) * s), Math.round((h + 2 * pad) * s))}</a>
  </div>`;
}

const card = ({ p, ai, findings, rejected, accepted: hidden }) => {
  const shots = Object.entries(p.records).filter(([, r]) => r.shot).sort(([a], [b]) => (reviewed(b) - reviewed(a)));
  const status = !AI ? "" : ai?.skipped ? `<span class="warn">partly not reviewed by Grok (budget)</span>` : ai?.fresh ? `<span class="muted">reviewed by Grok</span>` : ai?.reused ? `<span class="muted">review from ${esc(ai.reused.slice(0, 10))}, unchanged</span>` : "";
  return `<section class="card" id="${esc(p.route)}">
  <h3><code>${esc(p.path ?? p.route)}</code> ${status}</h3>
  ${findings.length ? `<ul>${findings.map((f) => `<li>${f.isNew ? `<span class="sev new">new</span> ` : ""}${badge(f.severity)} <span class="who">${f.source === "grok" ? "Grok" : "check"}</span> ${esc(f.problem)}${f.quote && f.source === "grok" ? ` <q>${esc(f.quote)}</q>` : ""}${f.where ? ` <span class="muted">— ${esc(f.where)}</span>` : ""} <span class="muted">[${esc(f.variant)}]</span>${f.source === "grok" && f.onPage === null ? ` <span class="muted">(no text to check)</span>` : ""} <button class="ok" data-line="${esc(pageLine(p.route, f))}">Fine as is</button>${spot(p, f)}</li>`).join("")}</ul>` : `<p class="muted">No findings.</p>`}
  ${hidden ? `<p class="muted">${hidden} finding${hidden === 1 ? "" : "s"} hidden by accepted.txt.</p>` : ""}
  ${rejected.length ? `<details><summary class="muted">${rejected.length} rejected Grok claim${rejected.length === 1 ? "" : "s"}</summary><ul>${rejected.map((f) => `<li class="muted">${esc(f.problem)} <q>${esc(f.quote)}</q> [${esc(f.variant)}] — rejected: ${esc(f.rejected ?? "the quoted text is not on the screenshot")}</li>`).join("")}</ul></details>` : ""}
  <div class="shots">${shots.map(([v, r]) => `<a href="${esc(r.shot)}" data-view="${esc(r.shot)}" data-size="${sizeOf(r.shot).join(",")}" title="${esc(v)}"><img loading="lazy" src="${esc(r.shot)}" alt="${esc(v)}"><span>${esc(v)}</span></a>`).join("")}</div>
</section>`;
};

const withFindings = pageRows.filter((r) => r.findings.length).sort((a, b) => bySeverity(a.findings[0], b.findings[0]));
const clean = pageRows.filter((r) => !r.findings.length);
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Visual review ${esc(process.env.STAMP ?? "")}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1d2330;--muted:#667085;--line:#e3e6eb;--high:#c4320a;--medium:#b54708;--low:#475467;--warn:#b54708}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--card:#171b23;--fg:#e6e8ec;--muted:#98a2b3;--line:#2a303b;--high:#f97066;--medium:#fdb022;--low:#98a2b3;--warn:#fdb022}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px}
h1{font-size:24px;margin:0 0 4px}h2{margin:32px 0 12px;font-size:19px}h3{font-size:15px;margin:0 0 8px;display:flex;gap:12px;flex-wrap:wrap;align-items:baseline}
.muted{color:var(--muted)}.warn{color:var(--warn)}.who{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:0 4px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}
.card ul{margin:0 0 12px;padding-left:18px}.card li{margin:4px 0}
.sev{display:inline-block;min-width:56px;text-align:center;font-size:12px;font-weight:600;border-radius:4px;padding:0 6px;color:#fff;background:var(--low)}
.sev.high{background:var(--high)}.sev.medium{background:var(--medium)}.sev.new{background:#2563eb;min-width:0}
.shots{display:flex;gap:10px;overflow-x:auto;padding-bottom:4px}.shots a{flex:none;text-decoration:none;color:var(--muted);font-size:12px;display:flex;flex-direction:column;gap:4px}
.shots img{height:220px;border:1px solid var(--line);border-radius:6px;object-fit:cover;object-position:top}
.where{margin:6px 0 14px}.cut{display:block;position:relative;overflow:hidden;border:1px solid var(--line);border-radius:6px;background:#fff}
.cut img{position:absolute;max-width:none}.whole{position:relative}.whole img{display:block;width:100%;border:1px solid var(--line);border-radius:6px}
.mark{position:absolute;border:3px solid #e11d48;border-radius:4px;box-shadow:0 0 0 2px #fff,0 0 0 9999px rgba(0,0,0,.18);pointer-events:none}
.where details{margin:4px 0 0}
.stats{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:14px}
td,th{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600}
.table{overflow-x:auto}details{margin:12px 0}code{font-size:13px}
button.ok{font:inherit;font-size:12px;color:var(--muted);background:none;border:1px solid var(--line);border-radius:4px;padding:0 6px;cursor:pointer}
.marked{opacity:.45}#marked{position:sticky;bottom:0;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin-top:16px}
#viewer{position:fixed;inset:0;z-index:10;background:rgba(10,12,16,.94);overflow:auto;padding:48px 24px}
#viewer[hidden]{display:none}#viewer .frame{position:relative;margin:0 auto}#viewer img{display:block;width:100%;border-radius:6px}
#viewer .bar{position:fixed;top:10px;right:16px;left:16px;display:flex;justify-content:space-between;color:#fff;font-size:13px}
#viewer button{font:inherit;color:#fff;background:rgba(255,255,255,.15);border:0;border-radius:6px;padding:4px 10px;cursor:pointer}
#marked textarea{width:100%;box-sizing:border-box;font:12px ui-monospace,monospace;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px}
</style></head><body><main>
<h1>Visual review</h1>
<p class="muted">${esc(process.env.COMMIT ?? "")} · ${pages.size} pages, ${sweeps.length} variants · ${AI ? `Grok (texts: ${esc(TEXT_MODEL)}, screenshots: ${esc(PAGE_MODEL)}) cost this run: <strong>$${spent.toFixed(2)}</strong> of $${MAX_USD}` : "without Grok: automatic checks only"}</p>
<div class="stats">
${previous ? `<div class="stat"><span class="sev new">new</span> since ${esc(since)}: ${newPages} on pages, ${newTexts} in texts</div>` : ""}
<div class="stat">Pages: ${badge("high")} ${pageCount.high} ${badge("medium")} ${pageCount.medium} ${badge("low")} ${pageCount.low}</div>
<div class="stat">Texts: ${badge("high")} ${textCount.high} ${badge("medium")} ${textCount.medium} ${badge("low")} ${textCount.low}</div>
</div>
${notes.length ? `<div class="card"><strong>Notes</strong><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>` : ""}
<p class="muted">"Fine as is" collects a line in the box at the bottom and copies the box. Paste it into <code>.grok-bot/accepted.txt</code>, then <code>.grok-bot/run.sh visual-review</code> redraws this report without those findings (free when nothing else changed).</p>
<p class="muted">"check" findings are measured in the browser and reliable. "Grok" findings are its reading of one screenshot; the text each one quotes was found on that screenshot, but the judgement can still be wrong: look before acting.</p>
<h2>Pages with findings (${withFindings.length})</h2>
${withFindings.map(card).join("\n")}
<details><summary>Pages without findings (${clean.length})</summary>${clean.map(card).join("\n")}</details>
${notReached.length ? `<details><summary>Routes the mock has no example for (${notReached.length})</summary><ul>${notReached.map((r) => `<li><code>${esc(r)}</code></li>`).join("")}</ul></details>` : ""}
<h2>Texts (${textRows.length})</h2>
<div class="table"><table><tr><th>Severity</th><th>Language</th><th>Key</th><th>Now</th><th>Problem</th><th>Suggestion</th></tr>
${textRows.map((f) => `<tr><td>${f.isNew ? `<span class="sev new">new</span> ` : ""}${badge(f.severity)} <span class="who">${f.source === "grok" ? "Grok" : "check"}</span></td><td>${esc(f.language)}</td><td><code>${esc(f.ns)}</code><br><code>${esc(f.key)}</code></td><td>${esc(f.current)}</td><td>${esc(f.problem)}</td><td>${esc(f.suggestion)} <button class="ok" data-line="${esc(textLine(f))}">Fine as is</button></td></tr>`).join("\n")}
</table></div>
<div id="marked" hidden><strong>Fine as is</strong> <span class="muted">— copied; paste into <code>.grok-bot/accepted.txt</code> (add <code># why</code> after a line if you like)</span>
<textarea id="lines" rows="4" readonly></textarea><button class="ok" id="copy">Copy again</button></div>
<div id="viewer" hidden><div class="bar"><span id="viewer-name"></span><button id="viewer-close">Close (Esc)</button></div><div class="frame"><img alt=""><span class="mark"></span></div></div>
<script>
// The whole screenshot in place, as wide as fits, with the finding's spot marked and in view.
const viewer = document.getElementById("viewer");
const frame = viewer.querySelector(".frame");
function view(link) {
  const [iw, ih] = link.dataset.size.split(",").map(Number);
  viewer.hidden = false; // measured open: a hidden element is 0 px wide
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
    const scale = width / iw;
    viewer.scrollTop = Math.max(0, (y + h / 2) * scale + 48 - viewer.clientHeight / 2);
  }
}
document.addEventListener("click", (e) => {
  const link = e.target.closest("a[data-view]");
  if (link) {
    e.preventDefault();
    view(link);
  } else if (!viewer.hidden && (e.target === viewer || e.target.id === "viewer-close")) viewer.hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") viewer.hidden = true;
});
const box = document.getElementById("lines");
async function copy(text) {
  try { await navigator.clipboard.writeText(text); } catch { box.select(); document.execCommand("copy"); }
}
document.addEventListener("click", async (e) => {
  const button = e.target.closest("button.ok");
  if (!button) return;
  if (button.id !== "copy") {
    const lines = new Set(box.value.split("\\n").filter(Boolean));
    lines.add(button.dataset.line);
    box.value = [...lines].join("\\n") + "\\n";
    document.getElementById("marked").hidden = false;
    button.closest("li, tr").classList.add("marked");
    button.textContent = "Marked";
  }
  await copy(box.value);
});
</script>
</main></body></html>`;
writeFileSync(join(OUT, "report.html"), html);

if (previous) console.log(`\nNew since the previous run: ${newPages} page findings, ${newTexts} text findings (compared with ${since})`);
console.log(`\nPages: ${pageCount.high} high, ${pageCount.medium} medium, ${pageCount.low} low · Texts: ${textCount.high} high, ${textCount.medium} medium, ${textCount.low} low`);
if (AI) console.log(`Grok cost this run: $${spent.toFixed(2)} (budget $${MAX_USD})`);
for (const n of notes) console.log(`Note: ${n}`);
