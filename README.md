# Grok frontend-testing bot

Writes and runs Playwright tests for the web app with xAI's Grok Build, in
the background, without access to anything else on this Mac. Local only:
this folder is excluded from Git (`.git/info/exclude`).

## What Grok can see

The container sees only, from a separate clone in `.worktrees/grok-tests`:

- `web/` (writable), with `web/src` read-only, so app code cannot change
- `api/`, `AGENTS.md` and the four files the web build reads (read-only)

Not mounted: the rest of the repo and its Git history, your working copy,
your home folder, SSH keys, Git and GitHub credentials. The tests run against
the mock build (fake data, no backend). Your running app is never touched.

Everything Grok reads (the files above, test output) is sent to xAI as
context. The GitHub token for `@data-insights-ai/*` is used only in a
separate install step and never reaches Grok's container.

## Setup (once)

1. Make an xAI API key just for this bot (console.x.ai), with a low spending
   limit. Store it in the Keychain:
   `security add-generic-password -a "$USER" -s grok-bot-xai -w`
   (paste the key when asked). Or `export XAI_API_KEY=...` before a run.
2. For the packages: `gh` signed in with `read:packages` (as in
   web/README.md), or `export GH_PACKAGES_TOKEN=...` (a classic token with
   only `read:packages`).

## Run

    .grok-bot/run.sh                        # the default task
    .grok-bot/run.sh tasks/<other>.md       # another task
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

1. **Sweep** (free, no network, no AI, 10-20 min): every route of
   `web/e2e/routes.ts`, in 8 variants (English, German, Spanish; desktop and
   phone; light and dark), against the mock with a fixed clock. Each page is
   screenshotted (up to two screens high) and checked automatically: console
   errors, sideways scrolling, cut-off text, raw text keys, unfilled
   `{{placeholders}}`, English left on German or Spanish pages.
2. **Free text checks**: missing German or Spanish texts, placeholders that
   differ from English, informal address (du / tú), sentences left in English.
3. **Grok** reviews the German and Spanish texts of every feature against
   the English (grok-4.3), then each screenshot on its own (grok-4.7,
   5 variants per page by default). Every finding must quote the text it is
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
| `REVIEW_VARIANTS='...'` | which screenshots Grok reviews now, by name or part of one (default: en-desktop-light en-phone-light en-desktop-dark de-phone-light es-phone-light); earlier reviews of other variants stay in the report |
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
without a suggestion: it follows `skill/visual-review/SKILL.md`, looks at the
screenshots and the three languages, and writes a suggestion per finding into
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
yes, Grok only after looking), the rules in `review-notes.md`, and fixing by
root cause under AGENTS.md (the project's checks, a commit on main once you
ask for it, a re-check with `SWEEP_ONLY`, a push only on your word). Link it once, from the project root:

    mkdir -p ~/.claude/skills && ln -s "$PWD/.grok-bot/skill/visual-review" ~/.claude/skills/visual-review

Then `/visual-review` in Claude Code, or just "check the frontend". The skill is
backed up with the kit.

## Backup

    .grok-bot/backup.sh             commit what changed and push it
    .grok-bot/backup.sh "message"   with your own message

Pushes this folder to github.com/tobias-klocker/grok-bot-ai-soc-frontend-testing
(private) with your own Git sign-in: scripts, settings, `verdicts.txt`,
`review-notes.md`, the review cache and Claude's triage in `state/`. `runs/` stays on this Mac
(`.gitignore`). The weekly run backs up after each run (`BACKUP=1` in
`schedule.conf`). To restore on another Mac: clone the repository into
`<project>/.grok-bot`, then exclude it there as here (`.git/info/exclude`).

## Clean up

    docker rmi $(docker images -q grok-bot-web)
    docker volume rm grok-bot-pnpm-store grok-bot-corepack
    .grok-bot/schedule.sh uninstall
    rm -rf .worktrees/grok-tests
    rm -rf .grok-bot/state         # forgets past reviews: the next visual run reviews everything
