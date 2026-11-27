// Turns a sweep (sweep.spec.ts) into a report: the automatic checks, free
// checks of the German and Spanish texts, then Grok on the screenshots and
// the texts, within a budget. Pages and texts that did not change since
// their last review keep that review and cost nothing.
//
// Reads /out/sweep, /out/shots, /src (the app's texts), /state, /verdicts.txt
// and /notes.md; writes /out/report.html, /out/findings.json and
// /state/visual-state.json.
//
// REDRAW=1 (or AI=0) asks Grok nothing: earlier reviews of unchanged
// screenshots and texts are shown, the rest is marked not reviewed. That is
// how the report picks up new verdicts and Claude's triage, for free.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { mergeVariants } from "./group.mjs";
import { renderReport, when } from "./report.mjs";
import { keyOf, norm, promptBlock, readTriage, readVerdicts, triageOf, verdictOf } from "./verdicts.mjs";

const OUT = process.env.REVIEW_OUT ?? "/out";
const SRC = process.env.REVIEW_SRC ?? "/src";
const STATE = process.env.REVIEW_STATE ?? "/state/visual-state.json";
const TRIAGE = process.env.REVIEW_TRIAGE ?? "/state/triage.json";
const REDRAW = process.env.REDRAW === "1";
const AI = !REDRAW && process.env.AI !== "0" && Boolean(process.env.XAI_API_KEY);
// Texts: a cheaper reasoning model (grok-build-0.1, used before, left the API
// on 2026-11-19; grok-4.7 left every text review unanswered for 270 s on
// 2026-11-23, though it reviews screenshots in seconds). Screenshots: the strongest Grok model for images (Roboflow
// vision evals, Nov 2026).
const TEXT_MODEL = process.env.TEXT_MODEL || "grok-4.3";
const PAGE_MODEL = process.env.PAGE_MODEL || process.env.REVIEW_MODEL || "grok-4.7";
// MAX_USD=none: no limit.
const MAX_USD = process.env.MAX_USD === "none" ? Infinity : Number(process.env.MAX_USD || 2);
const budgetText = Number.isFinite(MAX_USD) ? `${MAX_USD}` : "no limit";
const BUDGET = AI ? MAX_USD : 0;
// FULL=1 reviews everything again; FULL=texts only the translations, FULL=pages only the screenshots.
const FULL_TEXTS = ["1", "texts"].includes(process.env.FULL);
const FULL_PAGES = ["1", "pages"].includes(process.env.FULL);
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
// Chat Completions: proven for text and screenshots alike. Grok 4.7 left text
// requests over the Responses API unanswered (2026-11-23) while answering the
// same over Chat Completions in seconds.
let api = "chat";
let spent = 0;
let reserved = 0;
let calls = 0;
let imageTokens = 2500; // a first guess; measured on the first page
const notes = [];

// verdicts.txt (verdicts.mjs): fine and wrong hide findings and are named to
// Grok; fix keeps a finding as known until it is gone.
const verdicts = readVerdicts(process.env.REVIEW_VERDICTS ?? "/verdicts.txt", notes);
const triage = readTriage(TRIAGE, notes);
// review-notes.md: what the person wants Grok to know about the product.
const NOTES = process.env.REVIEW_NOTES ?? "/notes.md";
const houseNotes = existsSync(NOTES)
  ? readFileSync(NOTES, "utf8").split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).join("\n").trim()
  : "";
const notesBlock = houseNotes ? `\nNotes from the product's owner (they decide what is intended):\n${houseNotes}\n` : "";

// What Grok could not review this run, and models xAI answered "does not exist"
// for: those get no further requests, and the report and the log say so loudly.
const failures = [];
const goneModels = new Set();
const modelGone = (error) => /does not exist|not have access|model[_ ]not[_ ]found/i.test(error);

// An answer within 270 s, else the request is given up (Node's own limit is
// 300 s) and not repeated: a slow model would only be slow again, and xAI may
// bill an answer the connection no longer waits for.
const ANSWER_WITHIN_MS = Number(process.env.ANSWER_WITHIN_MS) || 270_000;
const timedOut = (e) => /timeout|aborted/i.test(`${e?.name} ${e?.message} ${e?.cause?.code ?? ""}`);

async function send(model, text, images, maxOut) {
  const responses = api === "responses";
  const content = responses
    ? [{ type: "input_text", text }, ...images.map((url) => ({ type: "input_image", image_url: url, detail: "high" }))]
    : [{ type: "text", text }, ...images.map((url) => ({ type: "image_url", image_url: { url, detail: "high" } }))];
  const body = responses
    ? { model, input: [{ role: "user", content }], max_output_tokens: maxOut, store: false }
    : { model, messages: [{ role: "user", content }], max_tokens: maxOut };
  const res = await fetch(`https://api.x.ai/v1/${responses ? "responses" : "chat/completions"}`, {
    signal: AbortSignal.timeout(ANSWER_WITHIN_MS),
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = `${res.status} ${JSON.stringify(data).slice(0, 400)}`;
    if (responses && calls === 0 && [400, 404, 405, 422].includes(res.status) && !modelGone(error)) {
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

// A model that left three requests unanswered this run gets no more: the rest
// would only wait out the limit too, one after another, and may be billed.
const silences = new Map();
async function ask(model, text, images = [], maxOut = 4000) {
  if (goneModels.has(model)) return { ok: false, retry: false, error: `xAI does not serve the model ${model}` };
  if ((silences.get(model) ?? 0) >= 3)
    return { ok: false, retry: false, error: `not sent: ${model} left 3 requests unanswered for ${ANSWER_WITHIN_MS / 1000} s this run` };
  for (let attempt = 0; ; attempt++) {
    const r = await send(model, text, images, maxOut).catch((e) => {
      if (!timedOut(e)) return { ok: false, retry: true, error: String(e) };
      silences.set(model, (silences.get(model) ?? 0) + 1);
      return { ok: false, retry: false, error: `no answer within ${ANSWER_WITHIN_MS / 1000} s (${model}); not repeated` };
    });
    if (!r.ok && modelGone(r.error)) goneModels.add(model);
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
      if (spent + reserved + cost > BUDGET) {
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

// A group's texts in parts of about 12,000 characters (en, de and es together):
// a whole group in one request can take a large model longer than a request may last.
function partsOf(t, size = 12_000) {
  const parts = [];
  let part = { en: {}, de: {}, es: {} };
  let length = 0;
  for (const key of Object.keys(t.en)) {
    const add = JSON.stringify([key, t.en[key], t.de[key], t.es[key]]).length;
    if (length + add > size && length) {
      parts.push(part);
      part = { en: {}, de: {}, es: {} };
      length = 0;
    }
    for (const l of ["en", "de", "es"]) if (t[l][key] !== undefined) part[l][key] = t[l][key];
    length += add;
  }
  if (length) parts.push(part);
  return parts;
}

const textPrompt = (ns, t) => `You review the German (de) and Spanish (es) user interface texts of a B2B security product (an AI-assisted SOC) against the English (en) source.

${glossary}
${notesBlock}
Report real problems only: wrong or missing meaning, English left untranslated, informal address, glossary violations, grammar or spelling errors, wrong plural forms, terms used inconsistently, and wording a native speaker would find clearly unnatural. Do not report matters of taste. At most 15 findings, most important first.

Answer with JSON only:
{"findings":[{"key":"<key>","language":"de|es","severity":"high|medium|low","problem":"<what is wrong, in English>","suggestion":"<better text>"}]}

Namespace: ${ns}${t.of > 1 ? ` (part ${t.part} of ${t.of}; the other parts are reviewed separately)` : ""}
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
${promptBlock(verdicts, p.route)}
For every finding, "quote" is the exact text in the screenshot the finding is about, copied character for character. For a problem that involves no text (for example two boxes overlapping), quote the text nearest to it, so its place can be marked. Findings are checked against the page's real text; a quote that is not there is discarded.

Answer with JSON only; an empty list if the screenshot looks fine:
{"findings":[{"severity":"high|medium|low","problem":"<what is wrong>","where":"<where on the screen>","quote":"<exact text or empty>"}]}`;

const textsOf = (r) => r.texts ?? r.boxes?.map((b) => b[0]);

// Grok types straight quotes where the page has typographic ones.
const plain = (x) => norm(x).replace(/[„“”«»]/g, '"').replace(/[‚‘’]/g, "'");
// A quote that runs over several pieces of the page's text is there when those
// pieces make up most of it; one word of a sentence Grok misquoted is not.
const covers = (pieces, q) => [...new Set(pieces)].reduce((sum, t) => sum + t.length, 0) >= 0.6 * q.length;

// Where a quoted text stands on a screenshot: its first place, or, for a
// quote that runs over several pieces of text, those pieces together.
function locate(quote, boxes) {
  const q = plain(quote);
  if (!q || !boxes?.length) return null;
  const whole = boxes.find((b) => plain(b[0]).includes(q));
  if (whole) return whole.slice(1);
  const parts = boxes.filter((b) => b[0].length >= 4 && q.includes(plain(b[0])));
  if (!parts.length || !covers(parts.map((b) => plain(b[0])), q)) return null;
  const near = parts.filter((b) => Math.abs(b[2] - parts[0][2]) < 300);
  const x = Math.min(...near.map((b) => b[1]));
  const y = Math.min(...near.map((b) => b[2]));
  return [x, y, Math.max(...near.map((b) => b[1] + b[3])) - x, Math.max(...near.map((b) => b[2] + b[4])) - y];
}

// Whether Grok's quote is text of that screenshot: true, false, or null when there is no quote to check.
function quoted(quote, texts) {
  const q = plain(quote);
  if (!q || !texts) return null;
  const all = texts.map(plain);
  return (
    all.some((t) => t.includes(q)) ||
    all.join(" ").includes(q) ||
    covers(
      all.filter((t) => t.length >= 4 && q.includes(t)),
      q,
    )
  );
}

const REVIEW_VERSION = 4; // raising it makes every screenshot be reviewed again
const aiPages = new Map(); // route -> { findings, reused, skipped }
function addPage(route, part) {
  const page = aiPages.get(route) ?? { findings: [] };
  page.findings.push(...part.findings);
  if (part.reused) page.reused = page.reused && page.reused < part.reused ? page.reused : part.reused;
  if (part.skipped) page.skipped = true;
  if (part.stale) page.stale = true;
  if (!part.reused && !part.skipped && !part.stale) page.fresh = true;
  aiPages.set(route, page);
}
const aiTexts = new Map(); // ns -> { findings, reused, skipped }

// Without AI (REDRAW=1, AI=0) the budget is 0: only earlier reviews are shown.
{
  // Texts first: cheap and complete.
  const textJobs = [];
  for (const [ns, t] of namespaces) {
    const h = hash(t.raw);
    const prev = state.texts[ns];
    if (!FULL_TEXTS && prev?.hash === h) aiTexts.set(ns, { findings: prev.findings, reused: prev.at });
    else textJobs.push({ ns, t, h });
  }
  const textEstimate = (j) => partsOf(j.t).reduce((sum, t) => sum + ((textPrompt(j.ns, t).length / 3) * priceOf(TEXT_MODEL).in + 1500 * priceOf(TEXT_MODEL).out) / 1e6, 0);
  console.log(`Texts: ${textJobs.length} namespaces to review, ${namespaces.size - textJobs.length} unchanged`);
  const textSkipped = await within(textJobs, textEstimate, async (j) => {
    const parts = partsOf(j.t);
    const findings = [];
    let cost = 0;
    for (const [i, t] of parts.entries()) {
      const r = await ask(TEXT_MODEL, textPrompt(j.ns, { ...t, part: i + 1, of: parts.length }), [], 4000);
      if (!r.ok) {
        console.log(`  ${j.ns} part ${i + 1}/${parts.length}: FAILED — ${r.error.slice(0, 200)}`);
        failures.push({ what: `texts ${j.ns}`, error: r.error });
        const prev = state.texts[j.ns];
        aiTexts.set(j.ns, { findings: (prev?.findings ?? []).map((f) => ({ ...f, stale: true })), stale: true });
        return;
      }
      findings.push(...findingsOf(r.answer).map((f) => ({ ...f, source: "grok" })));
      cost += r.cost;
      if (parts.length > 1) console.log(`  ${j.ns} part ${i + 1}/${parts.length} ($${r.cost.toFixed(3)})`);
    }
    aiTexts.set(j.ns, { findings });
    state.texts[j.ns] = { hash: j.h, findings, at: new Date().toISOString() };
    saveState();
    console.log(`  ${j.ns}: ${findings.length} findings ($${cost.toFixed(3)})`);
  });
  for (const j of textSkipped) aiTexts.set(j.ns, { findings: [], skipped: true });
  if (!AI && textSkipped.length) notes.push(`${textSkipped.length} text groups changed since Grok last reviewed them and were not reviewed in this run (${REDRAW ? "a redraw" : "AI=0"}).`);

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
      if (!FULL_PAGES && prev?.hash === h) {
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
      console.log(`  ${j.p.path} ${j.v}: FAILED — ${r.error.slice(0, 200)}`);
      failures.push({ what: `${j.p.route} ${j.v}`, error: r.error });
      const prev = state.pages[j.id];
      addPage(j.p.route, { findings: (prev?.findings ?? []).map((f) => ({ ...f, stale: true })), stale: true });
      return;
    }
    if (!measured) {
      measured = true;
      imageTokens = Math.max(100, Math.round(r.input - prompt.length / 3));
      const each = pageEstimate();
      console.log(`  A screenshot counts as about ${imageTokens} tokens, about $${each.toFixed(4)} with its prompt; all ${pageJobs.length} about $${(each * pageJobs.length).toFixed(2)} (budget left ${Number.isFinite(MAX_USD) ? `${(MAX_USD - spent).toFixed(2)}` : "no limit"})`);
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
  if (skipped.length)
    notes.push(
      AI
        ? `${skipped.length} screenshots were not reviewed: the budget of ${budgetText} was reached. Raise it with MAX_USD=…; the next run reviews them first.`
        : `${skipped.length} screenshots are new or changed since Grok last reviewed them and were not reviewed in this run (${REDRAW ? "a redraw" : "AI=0"}); .grok-bot/run.sh visual-review reviews them.`,
    );
}

// ---------------------------------------------------------------- findings
const order = { high: 0, medium: 1, low: 2 };
const bySeverity = (a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3);

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
// A claim that text is cut off, about text at the edge of a row that scrolls
// sideways (a tab bar, sweep.spec.ts): intended, as review-notes.md says.
const cutClaim = /cut off|cut-off|truncat|clipped|partially (visible|hidden|shown)|cropped/i;
function atScrollEdge(r, quote) {
  const box = locate(quote, r?.boxes);
  if (!box) return false;
  const [x, y, w, h] = box;
  return (r.scrollers ?? []).some(([sx, sy, sw, sh]) => y >= sy - 4 && y + h <= sy + sh + 4 && (x < sx + 24 || x + w > sx + sw - 24));
}
function judge(p, f) {
  if (f.source !== "grok") return f;
  const texts = textsOf(p.records[f.variant] ?? {});
  const onPage = texts ? quoted(f.quote, texts) : f.onPage;
  if (onPage === false) return { ...f, onPage, rejected: "the quoted text is not on the screenshot" };
  if (onPage && cutClaim.test(f.problem) && atScrollEdge(p.records[f.variant], f.quote))
    return { ...f, onPage: false, rejected: "it stands at the edge of a row that scrolls sideways (a tab bar): cut off there is intended" };
  const lang = String(f.variant).slice(0, 2);
  if (onPage && languageClaim.test(f.problem) && lang !== "en") {
    if (!wholeWords(f.quote, texts)) return { ...f, onPage: false, rejected: "the quote is only part of a word on the screenshot" };
    if (translations[lang]?.has(norm(f.quote)))
      return { ...f, onPage: false, rejected: `the ${lang === "de" ? "German" : "Spanish"} text file has exactly this text: it is the intended translation` };
  }
  return { ...f, onPage };
}

// The text keys whose text in a language is this text: one anchor for the
// same finding across languages (group.mjs). Plural forms count as one key.
const byText = Object.fromEntries(LANGS.map((l) => [l, new Map()]));
for (const [ns, t] of namespaces)
  for (const l of LANGS)
    for (const [key, text] of Object.entries(t[l])) {
      const n = norm(text);
      if (n) byText[l].set(n, [...(byText[l].get(n) ?? []), `${ns}#${key.replace(/_(zero|one|two|few|many|other)$/, "")}`]);
    }
const keysOf = (text, lang) => byText[lang]?.get(norm(text)) ?? [];

// Where a Grok finding stands on its screenshot, found by the text it quotes.
function withSpot(p, f) {
  if (f.spots?.length || f.source !== "grok") return f;
  const box = locate(f.quote, p.records[f.variant]?.boxes);
  return box ? { ...f, spots: [{ variant: f.variant, box }] } : f;
}

// New since the previous run: findings that run's findings.json does not hold.
// A page finding is known by its route, source and quote (or wording), per
// variant for Grok; a text finding by its key and language. A finding found
// in several variants is new when none of them was found before.
const PREVIOUS = process.env.REVIEW_PREVIOUS ?? "/previous.json";
const previous = existsSync(PREVIOUS) ? JSON.parse(readFileSync(PREVIOUS, "utf8")) : null;
const memberKey = (route, m) => [route, m.source, m.source === "grok" ? m.variant : "", norm(m.quote || m.problem)].join("|");
const textKey = (f) => [f.ns, f.key, f.language, f.source].join("|");
const known = new Set([
  ...(previous?.pages ?? []).flatMap((p) => p.findings.flatMap((f) => (f.members ?? [f]).map((m) => memberKey(p.route, { source: f.source, ...m })))),
  ...(previous?.texts ?? []).map(textKey),
]);

// Each finding's id (for Claude's triage) is its first member's; a text
// finding's includes its text, so a triage lapses when the text changes.
const withIds = (f, keys) => {
  const ids = keys.map(hash);
  return { ...f, id: ids[0], ids };
};

// Open findings, known ones (verdict fix) and the hidden (fine, wrong).
function sortOut(list, fresh) {
  const open = [];
  const knownOnes = [];
  const hidden = { fine: 0, wrong: 0 };
  for (const f of list) {
    const v = verdictOf(verdicts, f);
    const t = triageOf(triage, f);
    const add = t ? { triage: t } : {};
    if (v?.verdict === "fix") knownOnes.push({ ...f, ...add, known: true, decided: v.why || undefined });
    else if (v) hidden[v.verdict]++;
    else open.push({ ...f, ...add, isNew: Boolean(previous) && fresh(f) });
  }
  return { open, known: knownOnes, hidden };
}

const pageRows = [...pages.values()].map((p) => {
  const ai = aiPages.get(p.route);
  const judged = (ai?.findings ?? []).map((f) => judge(p, f));
  const rejected = judged.filter((f) => f.onPage === false);
  const kept = [...(auto.get(p.route) ?? []), ...judged.filter((f) => f.onPage !== false).map((f) => withSpot(p, f))];
  const merged = mergeVariants(p.route, kept, keysOf)
    .map((f) => withIds(f, f.members.map((m) => memberKey(p.route, m))))
    .sort(bySeverity);
  return { p, ai, rejected, ...sortOut(merged, (f) => !f.members.some((m) => known.has(memberKey(p.route, m)))) };
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
const texts = sortOut(
  [...namespaces.keys()]
    .flatMap((ns) =>
      [...(textChecks.get(ns) ?? []), ...(aiTexts.get(ns)?.findings ?? []).filter((f) => realText(ns, f))].map((f) => ({ ns, ...f, current: namespaces.get(ns)?.[f.language]?.[f.key] })),
    )
    .sort(bySeverity)
    // Grok may name one key twice; a text is decided once.
    .filter((f, i, all) => all.findIndex((o) => textKey(o) === textKey(f)) === i)
    .map((f) => withIds(f, [`${textKey(f)}|${f.current}`])),
  (f) => !known.has(textKey(f)),
);
if (droppedTexts) notes.push(`${droppedTexts} of Grok's text findings were dropped: they name a key that does not exist in that language, or suggest the current text unchanged.`);

// Known defects no longer found: fixed, most likely. Only where this run looked.
const looked = (v) => (v.kind === "text" ? namespaces.has(v.ns) : pages.has(v.route));
const gone = verdicts.filter((v) => v.verdict === "fix" && !v.hits && looked(v)).map(({ hits, lapsed, ...v }) => v);
const unused = verdicts.filter((v) => v.verdict !== "fix" && !v.hits && !v.lapsed && looked(v)).length;
const lapsed = verdicts.filter((v) => v.lapsed && !v.hits).length;
const hiddenCount = (k) => pageRows.reduce((n, r) => n + r.hidden[k], 0) + texts.hidden[k];
if (verdicts.length)
  notes.push(`verdicts.txt: ${verdicts.length} lines; hidden this run: ${hiddenCount("fine")} fine, ${hiddenCount("wrong")} wrong.${unused ? ` ${unused} fine/wrong lines matched nothing this run (the finding is gone, or its screenshot was not reviewed).` : ""}`);
if (lapsed) notes.push(`${lapsed} text verdicts no longer apply: the text changed since they were decided, so it is shown for a decision again.`);

const failedTexts = failures.filter((f) => f.what.startsWith("texts ")).length;
const failedShots = failures.length - failedTexts;
const failureSummary = [failedTexts && `${failedTexts} translation group${failedTexts === 1 ? "" : "s"}`, failedShots && `${failedShots} screenshot${failedShots === 1 ? "" : "s"}`].filter(Boolean).join(" and ");
const count = (list) => Object.fromEntries(["high", "medium", "low"].map((s) => [s, list.filter((f) => f.severity === s).length]));
const pageCount = count(pageRows.flatMap((r) => r.open));
const textCount = count(texts.open);
const newPages = pageRows.reduce((n, r) => n + r.open.filter((f) => f.isNew).length, 0);
const newTexts = texts.open.filter((f) => f.isNew).length;
const sinceName = previous?.shotAt ?? process.env.PREVIOUS_NAME ?? previous?.stamp;
const since = sinceName ? `the run of ${when(sinceName)}` : "the previous run";

// A redraw keeps what the run itself recorded: its stamps, commit and cost.
// The run's folder is named after its sweep: when the screenshots were taken.
const before = REDRAW && existsSync(join(OUT, "findings.json")) ? JSON.parse(readFileSync(join(OUT, "findings.json"), "utf8")) : null;
if (before) spent = before.spent ?? 0;
const stamp = process.env.STAMP || before?.stamp || "";
const commit = process.env.COMMIT || before?.commit || "";
const shotAt = before?.shotAt || process.env.RUN_NAME?.match(/^\d{8}-\d{6}/)?.[0] || stamp;

writeFileSync(
  join(OUT, "findings.json"),
  JSON.stringify(
    {
      stamp,
      shotAt,
      commit,
      pages: pageRows.map((r) => ({ route: r.p.route, path: r.p.path, findings: [...r.open, ...r.known] })),
      texts: [...texts.open, ...texts.known],
      gone,
      spent,
      notes,
    },
    null,
    1,
  ),
);

writeFileSync(
  join(OUT, "report.html"),
  renderReport({
    out: OUT,
    stamp,
    shotAt,
    commit,
    ai: AI,
    redraw: REDRAW,
    models: { text: TEXT_MODEL, page: PAGE_MODEL },
    spent,
    maxUsd: Number.isFinite(MAX_USD) ? MAX_USD : null,
    pageTotal: pages.size,
    variantTotal: sweeps.length,
    reviewed,
    failures,
    failureSummary,
    notes,
    pageRows,
    texts,
    notReached,
    since: previous ? since : null,
    newPages,
    newTexts,
    pageCount,
    textCount,
    causes: triage.causes,
    gone,
  }),
);

const triaged = [...pageRows.flatMap((r) => r.open), ...texts.open].filter((f) => f.triage).length;
const openTotal = pageRows.reduce((n, r) => n + r.open.length, 0) + texts.open.length;
if (previous) console.log(`\nNew since the previous run: ${newPages} page findings, ${newTexts} text findings (compared with ${since})`);
console.log(`\nPages: ${pageCount.high} high, ${pageCount.medium} medium, ${pageCount.low} low · Texts: ${textCount.high} high, ${textCount.medium} medium, ${textCount.low} low`);
console.log(`Open: ${openTotal}, triaged by Claude: ${triaged}, not yet: ${openTotal - triaged} · known, to fix: ${pageRows.reduce((n, r) => n + r.known.length, 0) + texts.known.length} · no longer found: ${gone.length}`);
if (AI) console.log(`Grok cost this run: $${spent.toFixed(2)} (budget ${budgetText})`);
for (const n of notes) console.log(`Note: ${n}`);
if (failures.length) console.log(`FAILED: Grok could not review ${failureSummary} (${failures[0].error.slice(0, 160)})`);
