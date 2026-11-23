---
name: visual-review
description: Run, read and act on the Grok frontend bot of ai-soc-platform (.grok-bot/) — screenshot sweep of every page, automatic checks, Grok's review of screenshots and German/Spanish texts, the report, triage, fixes and re-checks. Use for /visual-review, "check the frontend", "review the screenshots", "what did the bot find", "fix the findings", or anything about .grok-bot runs, findings, accepted.txt, review-notes.md, the weekly schedule or the backup.
---

# Visual review with the Grok bot

The kit lives in `.grok-bot/` in the root of the ai-soc-platform repository
(the repository that contains `.grok-bot/`; run every command from that root).
It is untracked there (`.git/info/exclude`) and backed up to its own private
repository by `.grok-bot/backup.sh`. `.grok-bot/README.md` is the full manual;
this skill is how to use it well.

## Ground rules

- **Never push, merge, tag or deploy** anything of ai-soc-platform or the design
  system (AGENTS.md). Fixes end as commits on a branch in a worktree, for the user.
- **Money:** Grok costs real money. Runs with `AI=0` are free. Before any run
  that may spend more than $3 (`MAX_USD` above 3, or a review of many changed
  screenshots), tell the user the estimate and wait for a yes. Prices: about
  $0.04–0.05 per screenshot (grok-4.7); a first review of every page in 5
  variants about $20; later runs pay only for changed screenshots and text files.
- **Docker must run** (Docker Desktop). Runs take a lock: one at a time.
- Do not change the kit's scripts, `accepted.txt`, `review-notes.md` or
  `schedule.conf`, and do not switch the schedule on, unless the user asks.
  After the user's changes to `accepted.txt` or `review-notes.md`, offer
  `.grok-bot/backup.sh`.
- The bot tests **committed** code only: the last commit of the checked-out
  branch, or `BASE=<branch>`. Uncommitted changes are never in a run.

## Commands

| Command | Does | Cost |
|---|---|---|
| `AI=0 .grok-bot/run.sh visual` | new sweep: every page, 8 variants, screenshots + automatic checks, report | free, 15–25 min |
| `MAX_USD=<n> .grok-bot/run.sh visual-review` | Grok reviews the last sweep's screenshots and texts; unchanged ones are reused | ≤ n |
| `MAX_USD=<n> .grok-bot/run.sh visual` | sweep and Grok in one go | ≤ n |
| `SWEEP_ONLY='<route regex>' …` | only the routes matching a regular expression (see below) | — |
| `SWEEP_VARIANTS='tablet wide qhd'` / `'all'` | extra sizes (820, 1920, 2560 px); default the 8 basic ones | — |
| `REVIEW_VARIANTS='en-desktop-light en-phone-light'` | which screenshots Grok reviews now | — |
| `RUN=<runs folder> …` | `visual`: add variants to that run; `visual-review`: review that run | — |
| `BASE=<branch> …` | test that branch instead of the checked-out one | — |
| `.grok-bot/run.sh` | Grok writes Playwright tests on a `bot/tests-<time>` branch of its clone; the script re-runs them | ~$1 |
| `.grok-bot/schedule.sh status` (or `install`, `uninstall`, `test`) | the weekly run (launchd); `AI=0 .grok-bot/schedule.sh test` is free | — |
| `.grok-bot/backup.sh` | push the kit to its GitHub repository | — |

Several routes in `SWEEP_ONLY`: `SWEEP_ONLY='cases/\$caseId$|settings$|license$'`
(the routes as in `web/e2e/routes.ts`, `$` before a parameter escaped).

A sweep takes 15–25 minutes: start it in the background (Bash with
`run_in_background`) and wait for it to finish; progress is in
`.grok-bot/runs/<run>/sweep.log`. Code changed since the last sweep needs
`visual`, not `visual-review` (that reuses the old screenshots).

## Reading a run

Each run is `.grok-bot/runs/<YYYYMMDD-HHMMSS>-visual/`:

- `report.html` — for the user: findings with marked cut-outs, a whole-screenshot
  viewer, "Fine as is" buttons. Open it for them with `open`.
- `findings.json` — for you:
  - `pages[]`: `{route, path, findings[]}`; each finding has `source`
    (`"check"` or `"grok"`), `severity`, `problem`, `variant` (e.g.
    `de-phone-light`; checks may list several), `quote` (the text it is about),
    `where`, `spots[{variant, box:[x,y,w,h]}]` (checks), `isNew`.
  - `texts[]`: `{ns, key, language, source, severity, problem, suggestion, current, isNew}`.
  - `notes[]`, `spent`, `stamp`. Rejected Grok claims are not in it (only,
    collapsed, in the report).
- `shots/<slug>/<variant>.png` — slug: the route without the leading `/`,
  without `$`, `/` as `__`; `/` itself is `root`
  (`/o/$orgId/w/$workspaceId/cases` → `o__orgId__w__workspaceId__cases`).
  Windows are two screens tall (desktop 1440×1800, phone 390×1688); nothing
  below that is covered.
- `review.log` — Grok's cost, counts, "New since the previous run".

## Triage: what to trust

1. **Start with what is new** (`isNew`) unless the user wants everything.
2. **`check` findings are measured in the browser and reliable.**
3. **Grok findings are a lead, not a fact.** In this project about half of
   Grok's serious screenshot claims turned out wrong (badges "overlapping" that
   do not, "English" buttons that say "Editar", correct bars called too short).
   Before reporting or fixing one, open its screenshot with Read and look at the
   spot yourself. Wrong ones: say so, and offer to add them to `accepted.txt`
   with a `# checked: wrong` comment.
4. **The user's rules** are in `.grok-bot/review-notes.md` (views are for
   technicians; ms timestamps and terms like "Standing terms" are intended; tab
   bars scroll; the h1 stands on one line with nothing beside it on desktop; the
   uppercase line above a title is the workspace name, i.e. sample data).
   `accepted.txt` holds single findings marked fine. Sample data (case titles,
   names of people, customers, workspaces, hosts) is never a finding.
5. **Text findings are suggestions.** Check each against the locale files
   (`web/src/**/locales/{en,de,es}.json`) and the glossary in
   `docs/how-to/develop-the-web-app.md`: formal "Sie"/"usted"; the AI SOC (de "der
   AI SOC", es "el AI SOC"); Workspace (de "Workspace", es "espacio de trabajo");
   Finding (de "Finding", es "hallazgo"); Case (de "Fall", es "caso"); roles
   without gender forms. Grok over-rates severity.
6. **Group by root cause.** Many findings share one cause (28 "headline shares
   its line" findings were one design-system component). Report causes, not
   findings: what is wrong, how many pages and variants, one or two screenshots
   as evidence, where the fix belongs. Then ask the user which causes to fix,
   and which to accept as fine.

Accepting a finding is a line in `.grok-bot/accepted.txt` (only with the user's
yes); `.grok-bot/run.sh visual-review` then redraws the report for free:

    page <route> "<quoted text, or the finding's words>"   # why
    text <namespace> <key> <de|es>                          # why

## Fixing

Follow AGENTS.md. Per root cause:

1. A worktree only under `.worktrees/<branch>` in the repository (never next to
   it), one at a time, removed after the user merged it.
2. Where the fix belongs:
   - The app: `web/src/…`.
   - Translations: the locale JSON files; `pnpm test` fails on a missing key or
     placeholder.
   - The design system `@data-insights-ai/ui` (`~/Developer/di`; e.g.
     `PageHeader`, `FactList`): propose it to the user first. Its releases and
     pins follow AGENTS.md, and the app only gets the change through a release.
3. Check like the project does (`docs/how-to/develop-the-web-app.md`): in
   `web/`, `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm format`.
4. Commit on the worktree's branch (the bot only sees commits), then re-check
   just the affected pages, free first:
   `BASE=<branch> SWEEP_ONLY='<routes>' AI=0 .grok-bot/run.sh visual`.
   The `check` findings must be gone. For Grok findings, look at the new
   screenshot yourself, or with the user's yes run the same with Grok (only
   changed screenshots cost).
5. Report to the user: the branch, what changed, the before/after evidence. No push.

## When something fails

- "Docker is not running": start Docker Desktop (`open -ga Docker`), wait, retry.
- "Another run is going": a run holds `.grok-bot/.lock`; wait for it.
- "No xAI key": it is read from the Keychain (`security add-generic-password -a
  "$USER" -s grok-bot-xai -w`); ask the user, never ask them to paste the key in
  the chat.
- Dependency install fails: `gh` must be signed in with `read:packages`.
- A sweep page "did not load" (`failed` in `sweep/<variant>.json`): open that
  page in `pnpm dev:mock` (`http://localhost:5174`) before blaming the app; the
  sweep follows `web/e2e/routes.ts`, `e2e/app.ts` and the mock scenarios
  `admin` and `partner`, so changes there can break it.
- Grok's model or API changed: `PAGE_MODEL` / `TEXT_MODEL` switch models; the
  errors are in the report's notes.
