# Grok frontend-testing bot

Screenshots every page of a frontend and has xAI's Grok review them and the
translated texts (the visual review, below), and writes Playwright tests for
it, in the background, without access to anything else on this Mac. Local
only: this folder is excluded from Git (`.git/info/exclude`).

The frontend it tests is described in `project/`; everything else is the same
for every frontend (see "Another frontend" at the end). Here it is
ai-soc-platform's web app.

## What Grok can see

The container sees only, from a separate clone in `.worktrees/grok-tests`,
what `project/project.json` "mounts" lists. For this project:

- `web/` (writable), with `web/src` read-only, so app code cannot change
- `api/`, `AGENTS.md` and the few files the web build reads (read-only)

Not mounted: the rest of the repo and its Git history, your working copy,
your home folder, SSH keys, Git and GitHub credentials. The tests run against
the mock build (fake data, no backend). Your running app is never touched.

Everything Grok reads (the files above, test output) is sent to xAI as
context. The token for a private registry (here GitHub Packages, for
`@data-insights-ai/*`) is used only in a separate install step and never
reaches Grok's container.

## Setup (once)

1. Make an xAI API key just for this bot (console.x.ai), with a low spending
   limit. Store it in the Keychain:
   `security add-generic-password -a "$USER" -s grok-bot-xai -w`
   (paste the key when asked). Or `export XAI_API_KEY=...` before a run.
2. Only for a frontend that installs from a private registry
   (`project.json` "privateRegistry"): here GitHub Packages, so `gh` signed in
   with `read:packages` (as in web/README.md), or `export
   GH_PACKAGES_TOKEN=...` (a classic token with only `read:packages`).

## Run

    .grok-bot/run.sh                        # the default task
    .grok-bot/run.sh tasks/<other>.md       # another task (in project/tasks/)
    BASE=feature-x .grok-bot/run.sh         # a branch other than the current one
    GROK_MODEL=<model> .grok-bot/run.sh     # another model

In the background: `nohup .grok-bot/run.sh >/dev/null 2>&1 &`. A macOS
notification shows when it is done. Every step Grok takes (tool calls, results, its final report) is in `runs/<time>.jsonl`. While it runs, `docker ps --filter name=grok-bot` shows the container; it is removed when done.

The bot tests the last commit, not uncommitted changes. Its changes become a
commit on `bot/tests-<time>` in the clone. Review and take it over from the
repo root:

    git fetch .worktrees/grok-tests bot/tests-<time>
    git diff HEAD...FETCH_HEAD
    git cherry-pick FETCH_HEAD

## Visual review

    .grok-bot/run.sh visual

1. **Sweep** (free, no network, no AI, 10-20 min): every route
   `project/pages.ts` lists, in the basic variants (each language on desktop
   and phone, the source language in dark too: 8 for English, German and
   Spanish), against the app as `project.json` "serve" starts it (here the
   mock), with a fixed clock. Each page is screenshotted (up to two screens
   high) and checked automatically: console errors, sideways scrolling,
   cut-off text, raw text keys, unfilled `{{placeholders}}`, source-language
   text left on pages in another language.
2. **Free text checks**: missing translations, placeholders that differ from
   the source, informal address (where `project.json` gives the pattern: du,
   tú), sentences left in the source language.
3. **Grok** reviews the translated texts of every feature against the source
   (grok-4.3), then each screenshot on its own (grok-4.7, 5 variants per page
   by default). Every finding must quote the text it is
   about; a quote that is not on that screenshot is rejected, and so is a
   claim that text is cut off at the edge of a row that scrolls sideways (a
   tab bar). Grok sees only what `visual/review.mjs` sends it: the
   screenshots and the texts.
4. **Report**: `runs/<time>-visual/report.html` opens by itself. Each
   finding shows a cut-out of its screenshot with the spot outlined (and the
   whole screenshot, marked, one click away): checks mark the element they
   measured, Grok's findings are found by the text they quote. "check"
   findings are measured and reliable; "Grok" findings are its reading of the
   screenshots, so compare with the screenshot before acting on one. The same
   finding in several languages or themes of one device is shown once, naming
   every variant (`visual/group.mjs`).

Costs: with grok-4.7 a screenshot costs about $0.01, so reviewing every page
in 5 variants for the first time is about $5 (3 variants: `REVIEW_VARIANTS`,
about $3). The texts are about $1 once. After that, only pages whose
screenshots changed and text files that changed are reviewed again
(`state/visual-state.json`); usually $0.10-0.50. The script measures what a
screenshot costs on the first page, prints the projection, and stops at the
budget; pages left over are reviewed first on the next run.

| Setting | Effect |
|---|---|
| `MAX_USD=1` | budget for Grok this run (default 2; `none`: no limit) |
| `AI=0` | sweep and free checks, and Grok's earlier reviews of screenshots that did not change; no key needed, $0 |
| `SWEEP_ONLY='inbox\|cases'` | only routes matching this expression (quick checks) |
| `SWEEP_VARIANTS='tablet'` | which variants to sweep, by name or part of one: `tablet` (820 px), `wide` (1920 px), `qhd` (2560 px), `de-`, `all`; default the 8 basic ones (desktop 1440 px, phone 390 px) |
| `RUN=<folder in runs/>` | with `visual`: add the swept variants to that run's report |
| `REVIEW_VARIANTS='...'` | which screenshots Grok reviews now, by name or part of one (default: the source language on desktop, light and dark, and phone, light; every other language on phone, light; here en-desktop-light en-phone-light en-desktop-dark de-phone-light es-phone-light); earlier reviews of other variants stay in the report |
| `FULL=1` | review everything again, changed or not; `FULL=texts` only the translations, `FULL=pages` only the screenshots |
| `PAGE_MODEL=...` | model for screenshots (default grok-4.7); changing it reviews them again |
| `TEXT_MODEL=...` | model for the texts (default grok-4.3; grok-build-0.1 left the API on 2026-11-19; grok-4.7 answers no text review within 270 s, tested 2026-11-23) |
| `RUN=<folder in runs/>` | with `visual-review`: which earlier sweep to review |

### Review again without a new sweep

    .grok-bot/run.sh visual-review

Reviews the last sweep's screenshots again: free for what was reviewed
before with the same model. `PAGE_MODEL=grok-4.6 .grok-bot/run.sh visual-review`
compares another model on the same screenshots.

### Claude's triage after each review

After every review (`run.sh visual`, `run.sh visual-review`, the weekly run)
`triage.sh` starts Claude Code once, unattended, when there are open findings
without a suggestion: it follows `skill/visual-review/SKILL.md` and
`project/claude-notes.md`, looks at the screenshots and the texts in every
language, and writes a suggestion per finding into
`state/triage.json`; the report is redrawn with them. The session can only
read files, write `state/triage-new.json` and run `visual/untriaged.mjs` and
`visual/triage-merge.mjs` (no other command, no network tool, no change to
the app or to `verdicts.txt`); the merge takes only findings of that run that
have no suggestion yet. It uses your Claude Code sign-in and its usage; its
answer is in `<run>/triage.log`. `TRIAGE=0` skips it, `.grok-bot/triage.sh`
runs it for the last run.

## The report with working buttons

    .grok-bot/run.sh report            # the last run; RUN=<folder in runs/> for another

Redraws the report with `verdicts.txt` and Claude's triage (no Grok, free),
serves it on http://127.0.0.1:7317 (`PORT=` for another) and opens it. Its
buttons save your verdicts into `verdicts.txt` at once; "Redraw with the new
verdicts" applies them. Ctrl-C ends it. It runs in the kit's image, published
on 127.0.0.1 only, and accepts writes only from the report itself. Opened as
a file instead, the buttons copy the lines to paste into `verdicts.txt`.

### Verdicts: fine, wrong, fix

Each finding has three buttons; the one Claude suggests is outlined:

- **Fine**: intended as it is. Hidden from later reports; Grok is told.
- **Wrong**: Grok misread the screenshot or text. Hidden; Grok is told it was wrong.
- **Fix**: a real defect. It stays in the report, under "Known, to fix" and
  not counted as new, until a run no longer finds it; then it is listed under
  "No longer found", where one click removes the line.

A cause's buttons decide all its findings at once. The lines in `verdicts.txt`:

    fine  page /o/$orgId/w/$workspaceId/cases "ws-fin-014"   # part of the case title
    wrong page /o/$orgId/sites "Dedicated node nbg1-07"      # the badge stands beside the title
    fix   page /o/$orgId "12"                                # the page is empty
    fine  text features/access productAdmins.title de "Produktadministratoren"

A `page` line matches findings on that route whose quoted text is, or
contains (6 characters or more), the text in quotes. A `text` line with the
text in quotes lapses when that text changes, so a changed text is decided
again; without the quotes it never lapses. A line without a verdict word is
`fine` (the older `accepted.txt` form).

### Claude's triage

Claude (the `visual-review` skill) suggests a verdict for each open finding,
with one sentence of evidence and where the fix belongs, and groups findings
by cause. It writes `state/triage.json`; the report shows the suggestions,
"By cause" and a filter (new, Claude suggests fix, fine or wrong, unsure, not
triaged). Suggestions are keyed by a finding's id, so an unchanged finding
keeps its suggestion in later runs. You decide: Claude does not write
`verdicts.txt`.

## Weekly run (prepared, off until you switch it on)

    .grok-bot/schedule.sh status      on or off, when, the last runs
    AI=0 .grok-bot/schedule.sh test   one run now, as the schedule runs it, without Grok: free
    .grok-bot/schedule.sh test        the same with Grok (uses the budget)
    .grok-bot/schedule.sh install     switch it on; again after changing schedule.conf
    .grok-bot/schedule.sh uninstall   switch it off

A launchd job of your user runs `scheduled.sh` at the time in `schedule.conf`
(Mondays 06:42 unless you change it): the visual review of `main` (as GitHub has it, fetched first;
`FROM_GITHUB=0` takes this Mac's) with every page, Grok within `MAX_USD` (`none` in `schedule.conf`: no limit). It
starts Docker Desktop when it is not running, takes the same lock as manual
runs (one run at a time), opens nothing, and ends with a notification either
way: how many findings are new since the previous run, what Grok cost, where
the report is, or why it failed. The log: `runs/scheduled-<time>.log`. It
keeps the newest `KEEP_RUNS` runs (8) and deletes older ones, manual ones too.

Needs: the Mac on and you logged in (asleep is fine: a missed run starts when
it wakes; switched off it is skipped), Docker Desktop installed, the xAI key
in the Keychain and `gh` signed in, as for manual runs. macOS may ask once to
allow notifications for the run.

Every report marks findings that are **new** since the previous run with a
report, and counts them at the top.

## Claude Code skill

`skill/visual-review/SKILL.md` teaches Claude Code this kit: the commands and
their cost, reading `findings.json` and the screenshots, what to trust (checks
yes, Grok only after looking), and fixing by root cause (the project's checks,
a commit once you ask for it, a re-check with `SWEEP_ONLY`, a push only on
your word). It is the same for every frontend: what is particular to this one
(the rules in `project/review-notes.md`, where texts and fixes live, Grok's
known misreads) is in `project/claude-notes.md`, which it reads first. Link it
once, from the project root:

    mkdir -p ~/.claude/skills && ln -s "$PWD/.grok-bot/skill/visual-review" ~/.claude/skills/visual-review

Then `/visual-review` in Claude Code, or just "check the frontend". The skill is
backed up with the kit.

## Backup

    .grok-bot/backup.sh             commit what changed and push it
    .grok-bot/backup.sh "message"   with your own message

Pushes this folder to its private repository (here
github.com/tobias-klocker/grok-bot-ai-soc-frontend-testing; the first backup
of a new kit names it: `BACKUP_REMOTE=<url> .grok-bot/backup.sh`) with your
own Git sign-in: scripts, settings, `project/`, `verdicts.txt`, the review
cache and Claude's triage in `state/`. `runs/` stays on this Mac
(`.gitignore`). The weekly run backs up after each run (`BACKUP=1` in
`schedule.conf`). To restore on another Mac: clone the repository into
`<project>/.grok-bot`, then exclude it there as here (`.git/info/exclude`).

## Clean up

    docker rmi $(docker images -q grok-bot-web)
    docker volume rm grok-bot-pnpm-store grok-bot-corepack
    .grok-bot/schedule.sh uninstall
    rm -rf .worktrees/grok-tests
    rm -rf .grok-bot/state         # forgets past reviews: the next visual run reviews everything

## Another frontend

The kit tests any web frontend that Playwright can open; only `project/`
describes this one. For another repository:

1. Copy this folder to `.grok-bot/` in that repository's root, without
   `project/`, `state/`, `runs/`, `verdicts.txt` and `.git`, and exclude it
   there (`echo .grok-bot >> .git/info/exclude`).
2. Write its `project/`, with this project's as the example:
   - `project.json`:
     - `product`: one line for Grok ("a booking app for clinics").
     - `app`: the frontend's folder in the repository (`.` for the root).
     - `exec`: how to run a dependency's command there (`npx`, `corepack pnpm exec`).
     - `install`: the clean install (`npm ci`); `installInputs`: the files
       whose change needs a new one (`package-lock.json`, `package.json`).
     - `privateRegistry`: a registry that needs a token, or leave it out.
     - `serve`: builds and starts the app on `{port}` without a backend
       (a mock, fixtures or a preview build with sample data).
     - `mounts`: what Grok's container sees, `<path>:ro|rw`, the frontend first.
     - `tests`: the Playwright folder in the app (for the test-writing bot).
     - `clock`: the time the browser is held at, so screenshots repeat.
     - `texts`: the folder under `app` with the text files and a pattern of
       their path: `{lang}` stands for the language, group 1 for an
       optional prefix that names its own group (`errors.de.json`).
     - `source` and `languages`: the language the texts are written in, and
       for each: `name`, `locale`, and for a language with formal address
       its `formal` word and an `informal` pattern. Codes have no dash
       (`pt`, not `pt-BR`): they start each variant's name.
     - `glossary`, `sampleData`, `staysEnglish`: what Grok is told about the
       texts and the data on the pages; any of them may be left out.
   - `pages.ts`: `routes`, `skip`, `scenarios` (the states the app is opened
     in, each with the routes it covers), `open`, `ready`, `setLanguage`,
     `paths` (a URL for each route, its parameters filled in) and `ignore`
     (a selector of the app's own development tools). It runs in the app's
     folder, so it may use the app's e2e helpers. A frontend without
     parameters returns its routes as they are from `paths`.
   - `review-notes.md`: what Grok should know (who uses it, what is intended).
   - `claude-notes.md`: what Claude needs for triage and fixes: the working
     rules, where texts and shared components are, the project's checks.
   - `tasks/frontend-tests.md`: the task for the test-writing bot.
3. The first backup names its private repository:
   `BACKUP_REMOTE=<url> .grok-bot/backup.sh`.
4. `AI=0 .grok-bot/run.sh visual` (free) shows whether the sweep reaches
   every page; `SWEEP_ONLY='<a route>'` keeps the first tries short.

The skill (`skill/visual-review`) is linked once per Mac; it reads the
`project/` of the repository it is used in.
