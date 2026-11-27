---
name: visual-review
description: Run, read and act on the Grok frontend bot (.grok-bot/ in the repository's root) — screenshot sweep of every page, automatic checks, Grok's review of screenshots and translated texts, the report, Claude's triage, verdicts, fixes and re-checks. Use for /visual-review, "check the frontend", "review the screenshots", "what did the bot find", "triage the report", "fix the findings", or anything about .grok-bot runs, findings, verdicts.txt, triage.json, review-notes.md, the weekly schedule or the backup.
---

# Visual review with the Grok bot

The kit lives in `.grok-bot/` in the root of the repository whose frontend it
tests (run every command from that root). It is untracked there
(`.git/info/exclude`) and backed up to its own private repository by
`.grok-bot/backup.sh`. `.grok-bot/README.md` is the full manual; this skill is
how to use it well.

The frontend is described in `.grok-bot/project/`: `project.json` (its
languages, build and texts), `pages.ts` (its routes and the states the sweep
opens), `review-notes.md` (what Grok is told) and `claude-notes.md` (what you
need on top: the project's working rules, where its texts and fixes live, its
checks, Grok's known misreads). **Read `claude-notes.md` before triaging or
fixing**; this skill is the same for every frontend.

## Ground rules

- **Commit only when the user asks, and push, tag, release or deploy only when
  they say so in that message** (the project's working rules in
  `claude-notes.md`, and the user's own).
- **Money:** Grok costs real money. Runs with `AI=0` are free. Before any run
  that may spend more than $3 (`MAX_USD` above 3, or a review of many changed
  screenshots), tell the user the estimate and wait for a yes. Prices: about
  $0.04–0.05 per screenshot (grok-4.7); a first review of every page in 5
  variants about $20; later runs pay only for changed screenshots and text files.
- **Docker must run** (Docker Desktop). Runs take a lock: one at a time.
- Do not change the kit's scripts, `project/`, `verdicts.txt` or
  `schedule.conf`, and do not switch the schedule on, unless the user asks.
  Verdicts are the user's: you suggest (`state/triage.json`), they decide
  (the report's buttons write `verdicts.txt`). After changes to
  `verdicts.txt`, `project/` or `state/triage.json`, offer
  `.grok-bot/backup.sh`.
- The bot tests **committed** code only: the last commit of the checked-out
  branch, or `BASE=<branch>`. Uncommitted changes are never in a run.

## Commands

| Command | Does | Cost |
|---|---|---|
| `AI=0 .grok-bot/run.sh visual` | new sweep: every page in the basic variants (each language on desktop and phone), screenshots + automatic checks, report | free, 15–25 min |
| `MAX_USD=<n> .grok-bot/run.sh visual-review` | Grok reviews the last sweep's screenshots and texts; unchanged ones are reused | ≤ n |
| `MAX_USD=<n> .grok-bot/run.sh visual` | sweep and Grok in one go | ≤ n |
| `SWEEP_ONLY='<route regex>' …` | only the routes matching a regular expression (see below) | — |
| `SWEEP_VARIANTS='tablet wide qhd'` / `'all'` | extra sizes (820, 1920, 2560 px); default the basic ones | — |
| `REVIEW_VARIANTS='en-desktop-light en-phone-light'` | which screenshots Grok reviews now | — |
| `RUN=<runs folder> …` | `visual`: add variants to that run; `visual-review`: review that run | — |
| `BASE=<branch> …` | test that branch instead of the checked-out one | — |
| `.grok-bot/run.sh report` (`RUN=…`) | redraws the last run's report with `verdicts.txt` and `state/triage.json`, serves it on http://127.0.0.1:7317 with working verdict buttons, opens it; runs until stopped | free |
| `.grok-bot/triage.sh` (`runs/<folder>`) | Claude's unattended triage of the last run (each review already runs it; `TRIAGE=0` skips that) | your Claude usage |
| `.grok-bot/run.sh` | Grok writes Playwright tests on a `bot/tests-<time>` branch of its clone; the script re-runs them | ~$1 |
| `.grok-bot/schedule.sh status` (or `install`, `uninstall`, `test`) | the weekly run (launchd); `AI=0 .grok-bot/schedule.sh test` is free | — |
| `.grok-bot/backup.sh` | push the kit to its GitHub repository | — |

Several routes in `SWEEP_ONLY`: `SWEEP_ONLY='cases/\$caseId$|settings$|license$'`
(the routes as `project/pages.ts` lists them, `$` before a parameter escaped).

A sweep takes 15–25 minutes: start it in the background (Bash with
`run_in_background`) and wait for it to finish; progress is in
`.grok-bot/runs/<run>/sweep.log`. Code changed since the last sweep needs
`visual`, not `visual-review` (that reuses the old screenshots).

## Reading a run

Each run is `.grok-bot/runs/<YYYYMMDD-HHMMSS>-visual/`:

- `report.html` — for the user: Claude's causes, then findings by page with
  marked cut-outs, Claude's suggestion and Fine / Wrong / Fix buttons, a filter,
  "Known, to fix" and "No longer found". Opened as a file the buttons copy
  lines; `.grok-bot/run.sh report` serves it so they save at once. Start that
  for the user (in the background) rather than `open`ing the file.
- `findings.json` — for you (open findings and known ones; fine and wrong are hidden):
  - `pages[]`: `{route, path, findings[]}`; each finding has `id`, `ids`,
    `source` (`"check"` or `"grok"`), `severity`, `problem`, `quote`,
    `where`, `variant` (all variants it was found in), `members[]` (the same
    finding per variant: `{variant, severity, problem, quote, where}`, one
    for each language and theme it was found in), `spots[{variant, box:[x,y,w,h]}]`,
    `isNew`, `known` (verdict fix), `triage` (your earlier suggestion).
  - `texts[]`: `{id, ns, key, language, source, severity, problem, suggestion, current, isNew, known, triage}`.
  - `gone[]`: fix verdicts whose finding was not found this run.
  - `notes[]`, `spent`, `stamp`, `commit`. Rejected Grok claims are not in
    it (only, collapsed, in the report).
- `shots/<slug>/<variant>.png` — slug: the route without the leading `/`,
  without `$`, `/` as `__`; `/` itself is `root`
  (`/o/$orgId/w/$workspaceId/cases` → `o__orgId__w__workspaceId__cases`).
  Windows are two screens tall (desktop 1440×1800, phone 390×1688); nothing
  below that is covered.
- `review.log` — Grok's cost, counts, "New since the previous run", and
  "Open: n, triaged by Claude: n, not yet: n".

## Triage: what to trust

1. **Start with what is new** (`isNew`) unless the user wants everything.
2. **`check` findings are measured in the browser and reliable.** Whether what
   they measure is a defect is still a judgement (a 200 px column may be a design).
3. **Grok findings are a lead, not a fact.** So far about half of
   Grok's serious screenshot claims turned out wrong (badges "overlapping" that
   do not, "English" buttons that say "Editar", correct bars called too short).
   Look at the spot yourself before suggesting anything. Crops are cheaper than
   whole screenshots: `sips -c <h> <w> --cropOffset <y> <x> <shot> --out <crop>`
   around the finding's `spots[0].box`. A quote can match elsewhere on the page
   (the sidebar has the page's name): crop the top of the page for headline findings.
4. **The user's rules** are in `.grok-bot/project/review-notes.md`; read it, it
   is the source. Sample data (`project.json` "sampleData": names, titles,
   hosts, counts) is never a finding.
5. **Text findings are suggestions.** Check each against the app's text files
   and the glossary (`claude-notes.md` says where they are, and lists Grok's
   known misreads of this project's texts). Grok over-rates severity. Count a
   term across the text files before calling a text inconsistent.
6. **Group by root cause.** Many findings share one cause. Report causes, not
   findings: what is wrong, how many pages and variants, one or two crops as
   evidence, where the fix belongs.

### Writing the triage

After each review `triage.sh` runs this triage unattended (a Claude Code
session limited to reading files and `visual/untriaged.mjs` /
`visual/triage-merge.mjs`; README.md). In a session with the user, check
`<run>/triage.log` and `review.log`'s "not yet"; triage what is left by hand.

After every run (asked for, or the weekly one when the user opens it), suggest
a verdict for every open finding without `triage` and write it to
`.grok-bot/state/triage.json`, merging with what is there:

    { "causes":   { "<cause-slug>": { "title", "suggest", "why", "fixIn", "at" } },
      "findings": { "<finding id>": { "suggest", "why", "cause", "at" } } }

- `suggest`: `fix` (a real defect), `fine` (intended, by the user's rules or
  the design), `wrong` (Grok's claim is false: say what is really there),
  `unsure` (say what would decide it: the user's call, or a look in the running app).
- `why`: one sentence the user can check, naming the evidence. `fixIn`: where
  the fix belongs, by the code you read (the file and what in it); where you
  have not read the code, it starts with "Guess:", since a symptom on a page
  often has its cause in a shared component (`claude-notes.md` says where they
  live). A cause's `suggest`/`why` apply to all its findings.
- Key by `id` from `findings.json` (a text's id includes its text, so a
  suggestion lapses when the text changes). Write with a small node script;
  then redraw for free with `.grok-bot/run.sh report`, and check
  `review.log`'s "not yet: 0".
- Never write `verdicts.txt` yourself unless the user tells you to: they
  decide in the report. Agreeing with your suggestion keeps your `why` as the
  line's comment.

### Verdicts (verdicts.txt, the user's)

    fine  page <route> "<quoted text>"              # intended: hidden
    wrong page <route> "<quoted text>"              # Grok misread it: hidden, and Grok is told
    fix   page <route> "<quoted text>"              # a real defect: stays as known until gone
    fine  text <namespace> <key> <language> "<text>"   # lapses when the text changes

A line without a verdict word is `fine`. A line hides findings on its route
whose quote is its text, or contains it (6 characters or more). "No longer
found" lists fix lines that matched nothing: fixed, most likely; the user
removes the line from the report.

## Fixing

Follow the project's working rules (`claude-notes.md`). Per root cause:

1. Where the fix belongs: the app, its text files, or a shared component
   (`claude-notes.md` says where each lives, and how a change to a shared
   library reaches the app). A fix outside the app's repository: propose it
   to the user first.
2. Check like the project does (`claude-notes.md` names its checks).
3. Once the user asked for the commit, commit (the bot only sees commits),
   then re-check just the affected pages, free first:
   `SWEEP_ONLY='<routes>' AI=0 .grok-bot/run.sh visual`.
   The `check` findings must be gone. For Grok findings, look at the new
   screenshot yourself, or with the user's yes run the same with Grok (only
   changed screenshots cost).
4. Report to the user: the commit, what changed, the before/after evidence.
   Push only when they say so.

## When something fails

- "Docker is not running": start Docker Desktop (`open -ga Docker`), wait, retry.
- "Another run is going": a run holds `.grok-bot/.lock`; wait for it.
- "No xAI key": it is read from the Keychain (`security add-generic-password -a
  "$USER" -s grok-bot-xai -w`); ask the user, never ask them to paste the key in
  the chat.
- Dependency install fails: a private registry (`project.json`
  "privateRegistry") needs its token; `claude-notes.md` says which.
- A sweep page "did not load" (`failed` in `sweep/<variant>.json`): open that
  page in the running app before blaming it (`claude-notes.md` says how); the
  sweep follows `project/pages.ts`, so a change to what it uses can break it.
- The report opens with a red "Grok could not review …" (the log has a
  `FAILED:` line): often a model xAI no longer serves (grok-build-0.1 left the
  API on 2026-11-19). Check docs.x.ai/developers/release-notes, then rerun with
  `TEXT_MODEL=` / `PAGE_MODEL=` (defaults grok-4.3 / grok-4.7, set in
  `visual/review.mjs`; the test-writing bot's `GROK_MODEL` in `run.sh`).
  Do not use grok-4.7 for texts: it left every text review unanswered for
  270 s (2026-11-23), though it reviews screenshots in seconds.
  Until then the earlier results stay in the report, marked "not re-checked":
  a drop in findings after such a run is that failure, not fixes.
