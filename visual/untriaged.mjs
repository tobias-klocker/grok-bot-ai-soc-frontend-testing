// What of a run still needs Claude's suggestion (triage.sh, SKILL.md):
// node .grok-bot/visual/untriaged.mjs <run folder>
// Prints the causes already known, then each open finding without a
// suggestion: a page finding with the screenshot to look at, a text finding
// with its English, German and Spanish as the reviewed commit has them.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const kit = resolve(import.meta.dirname, "..");
const run = resolve(process.argv[2] ?? "");
if (!existsSync(join(run, "findings.json"))) {
  console.error(`No findings.json in ${run}`);
  process.exit(1);
}
const findings = JSON.parse(readFileSync(join(run, "findings.json"), "utf8"));
const triage = existsSync(join(kit, "state/triage.json"))
  ? JSON.parse(readFileSync(join(kit, "state/triage.json"), "utf8"))
  : { causes: {}, findings: {} };
const src = join(kit, "..", ".worktrees/grok-tests/web/src");

const shots = new Map();
for (const file of readdirSync(join(run, "sweep")).filter((f) => f.endsWith(".json"))) {
  const records = JSON.parse(readFileSync(join(run, "sweep", file), "utf8"));
  for (const r of Array.isArray(records) ? records : Object.values(records))
    if (r.shot) shots.set(`${r.route} ${file.replace(/\.json$/, "")}`, join(run, r.shot));
}

// A key may be nested or hold dots itself ("actions": { "case.split": … }).
const walk = (node, parts) => {
  for (let i = parts.length; i > 0; i--) {
    const key = parts.slice(0, i).join(".");
    if (node && typeof node === "object" && key in node)
      return i === parts.length ? node[key] : walk(node[key], parts.slice(i));
  }
  return undefined;
};
const localeFile = (ns, lang) =>
  ns.endsWith("/errors")
    ? join(src, ns.replace(/\/errors$/, ""), "locales", `errors.${lang}.json`)
    : join(src, ns, "locales", `${lang}.json`);
const text = (ns, key, lang) => {
  const file = localeFile(ns, lang);
  return existsSync(file) ? walk(JSON.parse(readFileSync(file, "utf8")), key.split(".")) : undefined;
};
const known = (f) => (f.ids ?? [f.id]).some((id) => triage.findings[id]);

console.log("Causes already known (reuse a slug where a finding fits; suggest | title):");
for (const [slug, c] of Object.entries(triage.causes)) console.log(`  ${slug}: ${c.suggest} | ${c.title}`);

const pages = findings.pages.flatMap((p) => p.findings.filter((f) => !known(f)).map((f) => ({ ...f, route: p.route })));
console.log(`\nPage findings without a suggestion: ${pages.length}`);
for (const f of pages) {
  const first = f.spots?.[0];
  console.log(`- id ${f.id} | ${f.route} | ${f.source} ${f.severity} | ${f.variant}`);
  console.log(`  problem: ${f.problem}`);
  if (f.quote) console.log(`  quote: ${JSON.stringify(f.quote)}`);
  if (first) console.log(`  screenshot: ${shots.get(`${f.route} ${first.variant}`) ?? "(none)"} at box [x, y, w, h] ${JSON.stringify(first.box)}`);
}

const texts = findings.texts.filter((f) => !known(f));
console.log(`\nText findings without a suggestion: ${texts.length}`);
for (const f of texts) {
  console.log(`- id ${f.id} | ${f.ns} ${f.key} ${f.language} | ${f.severity}`);
  console.log(`  Grok: ${f.problem}`);
  console.log(`  Grok suggests: ${JSON.stringify(f.suggestion)}`);
  for (const lang of ["en", "de", "es"]) console.log(`  ${lang}: ${JSON.stringify(text(f.ns, f.key, lang))}`);
}
