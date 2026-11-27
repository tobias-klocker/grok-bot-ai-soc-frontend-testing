# What Claude needs to know about this frontend

The visual-review skill (`skill/visual-review/SKILL.md`) is the same for every
frontend; this file holds what is particular to this one: ai-soc-platform's
web app. Grok is told `review-notes.md`; this is for Claude's triage and fixes.

## Working rules

- Follow the repository's `AGENTS.md`. The user's commits go straight on
  `main`: no branch, no worktree. Commit only when the user asks; push, tag,
  release or deploy only when they say so in that message.

## Where things are

- The app: `web/src/…`; its routes for the sweep: `web/e2e/routes.ts`, signed
  in through `web/e2e/app.ts` (`project/pages.ts` uses both).
- Texts: `web/src/**/locales/{en,de,es}.json` and
  `web/src/shared/i18n/locales/errors.{en,de,es}.json`; the server keeps copies
  of some (`internal/iam/audit/httpapi/actionnames/*.json`,
  `internal/delivery/integrations/message/locales`,
  `internal/casework/reports/builtin/locales`). `pnpm test` fails on a missing
  key or a placeholder that differs.
- The glossary: `docs/how-to/develop-the-web-app.md`.
- The mock, to look at a page yourself: `pnpm dev:mock` in `web/`
  (http://localhost:5174); `?scenario=<name>` opens a scenario (`admin`,
  `partner`, `installationAdmin`; names in `web/src/mocks/scenarios.ts`).
- The design system `@data-insights-ai/ui` is `~/code/storybook` on this Mac
  (its built code in `web/node_modules/@data-insights-ai/ui`). A symptom on a
  page often has its cause in a shared component there (`PageHeader`,
  `FactList`, `DataTable`).

## Grok's known misreads of the texts

Check each text finding against the locale files and the glossary: formal
"Sie"/"usted"; the AI SOC (de "der AI SOC", es "el AI SOC"); Workspace (de
"Workspace", es "espacio de trabajo"); Finding (de "Finding", es "hallazgo");
Case (de "Fall", es "caso"); roles without gender forms. Grok over-rates
severity and misreads the glossary as banning German plurals and genitives
(die Findings, des Workspaces are correct), compound hyphens (AI-SOC-Größe is
correct) and Spanish invariant acronyms (las CPU). Microsoft's own names are
correct as they are (Log-Analytics-Arbeitsbereich, área de trabajo, Azure
Event Hubs-Datenempfänger), "Use" is Spanish (usted), Partner is the product's
term. Paired forms for people are fine where a text uses them, and never
required.

## Fixing

- Translations: the locale files above, and the server's copy where there is one.
- The design system: propose it to the user first. Read its `AGENTS.md` and
  `docs/` before changing it; it is a public repository. The app gets the
  change only through a release (its `docs/how-to/release.md`, on the user's
  word), and the app's pin moves in a commit of its own.
- Check like the project does (`docs/how-to/develop-the-web-app.md`): in
  `web/`, `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm format`.

## When the sweep fails

A page that "did not load" (`failed` in `sweep/<variant>.json`): open it in
`pnpm dev:mock` before blaming the app. The sweep follows `web/e2e/routes.ts`,
`web/e2e/app.ts` and the mock's scenarios, so changes there can break it.
Dependencies come from GitHub Packages: `gh` signed in with `read:packages`.
