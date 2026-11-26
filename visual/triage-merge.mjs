// Merges Claude's new suggestions into state/triage.json (triage.sh, SKILL.md):
// node .grok-bot/visual/triage-merge.mjs <run folder>
// reads state/triage-new.json:
//   { "causes":   { "<slug>": { "title", "suggest", "why", "fixIn" } },
//     "findings": { "<finding id>": { "suggest", "why", "cause" } } }
// Only findings of that run that have no suggestion yet are taken, and only
// causes not known yet: what the person or an earlier triage decided stays.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const kit = resolve(import.meta.dirname, "..");
const run = resolve(process.argv[2] ?? "");
const newFile = join(kit, "state/triage-new.json");
const triageFile = join(kit, "state/triage.json");
const fail = (why) => {
  console.error(`Nothing merged: ${why}`);
  process.exit(1);
};
if (!existsSync(join(run, "findings.json"))) fail(`no findings.json in ${run}`);
if (!existsSync(newFile)) fail("no state/triage-new.json");

let incoming;
try {
  incoming = JSON.parse(readFileSync(newFile, "utf8"));
} catch (e) {
  fail(`state/triage-new.json is not JSON (${e.message})`);
}
const findings = JSON.parse(readFileSync(join(run, "findings.json"), "utf8"));
const triage = existsSync(triageFile) ? JSON.parse(readFileSync(triageFile, "utf8")) : { causes: {}, findings: {} };
const at = new Date().toISOString().slice(0, 10);
const verdicts = new Set(["fix", "fine", "wrong", "unsure"]);
const str = (v, max) => typeof v === "string" && v.trim() !== "" && v.length <= max;

// Every id of the run's open findings, and which of them are still without a suggestion.
const open = [...findings.pages.flatMap((p) => p.findings), ...findings.texts];
const idsOf = new Map(open.flatMap((f) => (f.ids ?? [f.id]).map((id) => [id, f])));
const untriaged = new Set(open.filter((f) => !(f.ids ?? [f.id]).some((id) => triage.findings[id])).flatMap((f) => f.ids ?? [f.id]));

const problems = [];
let causes = 0;
for (const [slug, c] of Object.entries(incoming.causes ?? {})) {
  if (triage.causes[slug]) continue;
  if (!/^[a-z0-9-]{2,60}$/.test(slug) || !verdicts.has(c?.suggest) || !str(c?.title, 120) || !str(c?.why, 600))
    problems.push(`cause ${slug}: needs a slug, title, suggest (fix|fine|wrong|unsure) and why`);
  else {
    triage.causes[slug] = { title: c.title, suggest: c.suggest, fixIn: str(c.fixIn, 300) ? c.fixIn : "", why: c.why, at };
    causes++;
  }
}
const tally = { fix: 0, fine: 0, wrong: 0, unsure: 0 };
let skipped = 0;
for (const [id, s] of Object.entries(incoming.findings ?? {})) {
  if (!idsOf.has(id)) {
    problems.push(`finding ${id}: not a finding of this run`);
    continue;
  }
  if (!untriaged.has(id)) {
    skipped++;
    continue;
  }
  if (!verdicts.has(s?.suggest) || !str(s?.why, 600) || (s.cause !== undefined && !triage.causes[s.cause]))
    problems.push(`finding ${id}: needs suggest (fix|fine|wrong|unsure), why, and a known cause or none`);
  else {
    // A merged finding carries several ids; the suggestion goes to each.
    for (const each of idsOf.get(id).ids ?? [id]) {
      triage.findings[each] = { suggest: s.suggest, why: s.why, ...(s.cause ? { cause: s.cause } : {}), at };
      untriaged.delete(each);
    }
    tally[s.suggest]++;
  }
}
writeFileSync(triageFile, JSON.stringify(triage, null, 1) + "\n");
rmSync(newFile);
const left = open.filter((f) => !(f.ids ?? [f.id]).some((id) => triage.findings[id])).length;
console.log(
  `Merged ${tally.fix + tally.fine + tally.wrong + tally.unsure} suggestions (${tally.fix} fix, ${tally.fine} fine, ${tally.wrong} wrong, ${tally.unsure} unsure), ${causes} new causes; ${skipped} already had one; still without a suggestion: ${left}`,
);
for (const p of problems) console.log(`Not taken: ${p}`);
