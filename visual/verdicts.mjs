// verdicts.txt: the person's decisions on findings, one line each.
//
//   fine  page <route> "<quoted text>"                # intended as it is
//   wrong page <route> "<quoted text>"                # Grok misread the screenshot
//   fix   page <route> "<quoted text>"                # a real defect, known, to be fixed
//   fine  text <namespace> <key> <language> "<the text>" # the text as it was decided on
//
// fine and wrong hide a finding; fix keeps it, as known, until it is no longer
// found. A line without a verdict word is "fine" (the older accepted.txt form).
// A text line lapses when its text changed since; one without a text never does.
import { existsSync, readFileSync } from "node:fs";

export const VERDICTS = ["fine", "wrong", "fix"];

export const norm = (x) =>
  String(x ?? "")
    .toLowerCase()
    .replace(/[\s\u00ad]+/g, " ")
    .replace(/^[\s"'„“”«»‚‘’]+|[\s"'„“”«»‚‘’.…]+$/g, "");
// What a page finding is known by: the text it quotes, else its wording.
export const keyOf = (f) => (f.quote && String(f.quote).trim() ? f.quote : f.problem);

const quoted = (s) => `"${String(s).replace(/\s+/g, " ").replace(/["\\]/g, "\\$&")}"`;
const unquote = (s) => s.replace(/\\(.)/g, "$1");
const QUOTE = `"((?:[^"\\\\]|\\\\.)*)"`;
const PAGE = new RegExp(`^(?:(fine|wrong|fix)\\s+)?page\\s+(\\S+)\\s+${QUOTE}\\s*(?:#\\s*(.*))?$`);
const TEXT = new RegExp(`^(?:(fine|wrong|fix)\\s+)?text\\s+(\\S+)\\s+(\\S+)\\s+([a-z]{2,3})(?:\\s+${QUOTE})?\\s*(?:#\\s*(.*))?$`);

// One line: an entry, null for a comment or blank line, undefined when unreadable.
export function parseLine(raw) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) return null;
  let m;
  if ((m = PAGE.exec(line))) return { verdict: m[1] ?? "fine", kind: "page", route: m[2], text: unquote(m[3]), why: m[4] ?? "" };
  if ((m = TEXT.exec(line)))
    return { verdict: m[1] ?? "fine", kind: "text", ns: m[2], key: m[3], language: m[4], was: m[5] === undefined ? undefined : unquote(m[5]), why: m[6] ?? "" };
  return undefined;
}

// Two lines about the same finding: a new verdict replaces the old line.
export const sameTarget = (a, b) =>
  a.kind === b.kind && (a.kind === "page" ? a.route === b.route && norm(a.text) === norm(b.text) : a.ns === b.ns && a.key === b.key && a.language === b.language);

export function readVerdicts(path, notes) {
  const entries = [];
  if (!existsSync(path)) return entries;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const entry = parseLine(raw);
    if (entry === undefined) notes.push(`verdicts.txt: this line could not be read: ${raw.trim()}`);
    else if (entry) entries.push({ ...entry, hits: 0, lapsed: 0 });
  }
  return entries;
}

// A page line matches a finding on its route whose quote (or wording) is the
// line's text, or whose quote contains it (6 characters or more).
const pageMatch = (v, route, m) => {
  if (v.route !== route) return false;
  const t = norm(v.text);
  return t === norm(keyOf(m)) || (t.length >= 6 && norm(m.quote).includes(t));
};

// The verdict on a finding: a page finding by any of its members (the same
// finding in other variants), a text finding by key, while its text is
// unchanged. Every matching line counts as used; the last one decides.
export function verdictOf(entries, f) {
  let decided = null;
  for (const v of entries) {
    if (f.ns) {
      if (v.kind !== "text" || v.ns !== f.ns || v.key !== f.key || v.language !== f.language) continue;
      if (v.was !== undefined && v.was !== f.current) {
        v.lapsed++;
        continue;
      }
    } else if (v.kind !== "page" || !f.members.some((m) => pageMatch(v, f.route, m))) continue;
    v.hits++;
    decided = v;
  }
  return decided;
}

// What a verdict line names, without the verdict: one per text a page finding
// quotes in its variants, so each variant's finding is matched on its own later.
export function targetsOf(f) {
  if (f.ns) return [`text ${f.ns} ${f.key} ${f.language} ${quoted(f.current ?? "")}`];
  return [...new Set(f.members.map((m) => `page ${f.route} ${quoted(keyOf(m))}`))];
}
export const lineOf = (v) =>
  `${v.verdict} ${v.kind === "text" ? `text ${v.ns} ${v.key} ${v.language}${v.was === undefined ? "" : ` ${quoted(v.was)}`}` : `page ${v.route} ${quoted(v.text)}`}`;

// What Grok is told about a page before it reviews it again. Known defects
// (fix) are not named: Grok should keep reporting them until they are gone.
export function promptBlock(entries, route) {
  const own = entries.filter((v) => v.kind === "page" && v.route === route);
  const fine = own.filter((v) => v.verdict === "fine");
  const wrong = own.filter((v) => v.verdict === "wrong");
  const list = (vs) => vs.map((v) => `- "${v.text}"${v.why ? ` (${v.why})` : ""}`).join("\n");
  return [
    fine.length ? `\nAlready reviewed and fine as it is, do not report again:\n${list(fine)}\n` : "",
    wrong.length ? `\nEarlier claims about this page that were checked against the screenshot and are wrong; do not make them again:\n${list(wrong)}\n` : "",
  ].join("");
}

// Claude's triage (state/triage.json), suggestions only: the person decides.
//   { "causes":   { "<cause>": { "title", "suggest", "why", "fixIn" } },
//     "findings": { "<finding id>": { "suggest": "fix|fine|wrong|unsure", "why", "cause" } } }
export function readTriage(path, notes) {
  if (!existsSync(path)) return { causes: {}, findings: {} };
  try {
    const t = JSON.parse(readFileSync(path, "utf8"));
    return { causes: t.causes ?? {}, findings: t.findings ?? {} };
  } catch (e) {
    notes.push(`state/triage.json could not be read: ${String(e).slice(0, 160)}`);
    return { causes: {}, findings: {} };
  }
}
export const triageOf = (triage, f) => f.ids.map((id) => triage.findings[id]).find(Boolean) ?? null;
