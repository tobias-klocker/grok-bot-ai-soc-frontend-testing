#!/usr/bin/env bash
# Grok frontend-testing bot (README.md).
#
#   .grok-bot/run.sh                    the default task (tasks/frontend-tests.md)
#   .grok-bot/run.sh tasks/<file>.md    another task
#   BASE=my-branch .grok-bot/run.sh     test a branch other than the one checked out
#   .grok-bot/run.sh visual             screenshot every page, have Grok review them (README.md)
#   .grok-bot/run.sh visual-review      review the last visual run's screenshots again, no new sweep
#
# Grok runs in a container that sees only a separate clone's web app, the API
# contract and the few files the web build reads: no git history, no Go
# backend, no deploy configuration, nothing else of this Mac. Its changes
# become a commit on a bot/ branch of that clone, to review and take over.
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$KIT/.." && pwd)"
CLONE="$REPO/.worktrees/grok-tests"
BASE="${BASE:-HEAD}"
MODE=tests
if [ "${1:-}" = visual ]; then MODE=visual; TASK=""
elif [ "${1:-}" = visual-review ]; then MODE=review; TASK=""; else
  TASK="${1:-$KIT/tasks/frontend-tests.md}"
  case "$TASK" in /*) ;; *) [ -f "$TASK" ] || TASK="$KIT/$TASK" ;; esac
fi
STAMP="$(date +%Y%m%d-%H%M%S)"
BRANCH="bot/tests-$STAMP"
LOG="$KIT/runs/$STAMP.jsonl"
REPORT="$KIT/runs/$STAMP.report.md"
VERIFY="$KIT/runs/$STAMP.verify.log"

say() { printf '\033[1m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# One run at a time: runs share the clone and the review cache. A lock whose
# process is gone was left by a run that was stopped, and is taken over.
RUN_LOCK="$KIT/.lock"
if ! mkdir "$RUN_LOCK" 2>/dev/null; then
  other="$(cat "$RUN_LOCK/pid" 2>/dev/null || true)"
  if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then die "Another run is going (process $other); try again when it is done."; fi
  rm -rf "$RUN_LOCK" && mkdir "$RUN_LOCK"
fi
echo $$ > "$RUN_LOCK/pid"
trap 'rm -rf "$RUN_LOCK"' EXIT

command -v docker >/dev/null || die "Docker is not installed."
docker info >/dev/null 2>&1 || die "Docker is not running."
[ "$MODE" != tests ] || [ -f "$TASK" ] || die "No task file at $TASK."

# The xAI key: from the environment, else from the macOS Keychain (README.md).
XAI_API_KEY="${XAI_API_KEY:-}"
if [ -z "$XAI_API_KEY" ] && command -v security >/dev/null; then
  XAI_API_KEY="$(security find-generic-password -s grok-bot-xai -w 2>/dev/null || true)"
fi
if [ -z "$XAI_API_KEY" ] && ! { [ "$MODE" != tests ] && [ "${AI:-1}" = 0 ]; }; then
  die "No xAI key: set XAI_API_KEY or store it in the Keychain (README.md)."
fi
export XAI_API_KEY

hardening=(--init --cap-drop ALL --security-opt no-new-privileges --pids-limit 2048)

# Review only: the last sweep's screenshots, as the clone holds them now.
if [ "$MODE" = review ]; then
  [ -f "$CLONE/web/package.json" ] || die "Nothing to review yet: run .grok-bot/run.sh visual first."
  IMAGE="grok-bot-web:pw$(sed -nE 's/.*"@playwright\/test": *"([^"]+)".*/\1/p' "$CLONE/web/package.json")"
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "The image $IMAGE is gone: run .grok-bot/run.sh visual first."
  . "$KIT/visual/run.sh"
fi

# 1. The clone: the commit to test, on a fresh bot branch. Your working copy
#    is only read from.
if [ ! -d "$CLONE/.git" ]; then
  say "Creating the bot's clone in .worktrees/grok-tests"
  git clone --quiet --no-checkout "$REPO" "$CLONE"
  git -C "$CLONE" remote remove origin
fi
if [ "$BASE" = HEAD ] && [ -n "$(git -C "$REPO" status --porcelain)" ]; then
  say "Note: uncommitted changes are not tested, only the last commit of $(git -C "$REPO" branch --show-current)"
fi
git -C "$CLONE" reset --hard -q 2>/dev/null || true
git -C "$CLONE" clean -fdq
git -C "$CLONE" fetch --quiet "$REPO" "$BASE"
if [ "$MODE" = visual ]; then
  git -C "$CLONE" checkout --quiet --detach FETCH_HEAD
  say "Reviewing $(git -C "$CLONE" log -1 --format='%h %s')"
else
  git -C "$CLONE" checkout --quiet -B "$BRANCH" FETCH_HEAD
  say "Testing $(git -C "$CLONE" log -1 --format='%h %s') on $BRANCH"
fi

# What the container sees (paths in the clone). The web build reads the
# API contract, the sample report and the Azure onboarding files.
MOUNTS="
web:rw
web/src:ro
api:ro
AGENTS.md:ro
docs/how-to/develop-the-web-app.md:ro
docs/explanation/frontend.md:ro
internal/casework/reports/render/testdata:ro
internal/casework/reports/httpapi/download.go:ro
deploy/azure/onboarding.sh:ro
deploy/azure/main.json:ro
"
mount_args=()
for m in $MOUNTS; do
  path="${m%:*}"; mode="${m##*:}"
  [ -e "$CLONE/$path" ] || die "$path is gone from the repository: update MOUNTS in run.sh."
  mount_args+=(-v "$CLONE/$path:/work/$path:$mode")
done

# 2. The image, per Playwright version of the tests.
PW_VERSION="$(sed -nE 's/.*"@playwright\/test": *"([^"]+)".*/\1/p' "$CLONE/web/package.json")"
[ -n "$PW_VERSION" ] || die "No @playwright/test version in web/package.json."
IMAGE="grok-bot-web:pw$PW_VERSION"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  say "Building $IMAGE (once per Playwright version, a few minutes)"
  docker build --quiet --build-arg PLAYWRIGHT_VERSION="$PW_VERSION" -t "$IMAGE" "$KIT" >/dev/null
fi

caches=(-v grok-bot-pnpm-store:/home/node/.pnpm-store -v grok-bot-corepack:/home/node/.cache/node/corepack)
# 3. Dependencies, in a container of their own: the GitHub token for
#    @data-insights-ai/* is never in the container Grok runs in.
LOCK="$(git -C "$CLONE" hash-object web/pnpm-lock.yaml web/package.json | tr -d '\n')"
if [ "$(cat "$CLONE/web/node_modules/.grok-bot-lock" 2>/dev/null)" != "$LOCK" ]; then
  say "Installing dependencies"
  NODE_AUTH_TOKEN="${GH_PACKAGES_TOKEN:-}"
  if [ -z "$NODE_AUTH_TOKEN" ] && command -v gh >/dev/null; then
    NODE_AUTH_TOKEN="$(gh auth token 2>/dev/null || true)"
  fi
  [ -n "$NODE_AUTH_TOKEN" ] || die "No GitHub token for the packages: set GH_PACKAGES_TOKEN or sign in with gh."
  export NODE_AUTH_TOKEN
  docker run --rm "${hardening[@]}" -e NODE_AUTH_TOKEN "${caches[@]}" \
    -v "$CLONE/web:/work/web" -w /work/web "$IMAGE" \
    bash -c 'printf "//npm.pkg.github.com/:_authToken=\${NODE_AUTH_TOKEN}\n" > ~/.npmrc \
      && corepack pnpm install --frozen-lockfile --store-dir ~/.pnpm-store --reporter=silent'
  unset NODE_AUTH_TOKEN
  printf '%s\n' "$LOCK" > "$CLONE/web/node_modules/.grok-bot-lock"
fi

[ "$MODE" = visual ] && . "$KIT/visual/run.sh"

# 4. Grok.
say "Grok is working (container grok-bot-$STAMP); every step goes to .grok-bot/runs/$STAMP.jsonl"
# xAI's coding model; GROK_MODEL= (empty) leaves the choice to the CLI.
GROK_MODEL="${GROK_MODEL-grok-build-0.1}"
model_args=()
[ -n "$GROK_MODEL" ] && model_args=(-m "$GROK_MODEL")
set +e
docker run --rm "${hardening[@]}" --shm-size 1g --name "grok-bot-$STAMP" \
  -e XAI_API_KEY "${caches[@]}" "${mount_args[@]}" -w /work "$IMAGE" \
  grok --no-auto-update --trust --always-approve --cwd /work --output-format streaming-json \
  "${model_args[@]+"${model_args[@]}"}" -p "$(cat "$TASK")" 2>&1 | tee "$LOG"
status=${PIPESTATUS[0]}
set -e
# Grok's own words, readable; check them against what follows.
docker run --rm -i --network none "$IMAGE" node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const events = s.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    process.stdout.write(events.filter((e) => e.type === "text").map((e) => e.data || "").join("") + "\n");
  });' < "$LOG" > "$REPORT" || true

# 5. The result as a commit on the bot branch (your Git signing is not used).
cd "$CLONE"
if [ -z "$(git status --porcelain)" ]; then
  printf '\033[33m! Grok changed no file (exit %s). Ignore any report that says otherwise; see %s\033[0m\n' "$status" "$LOG"
  command -v osascript >/dev/null && osascript -e "display notification \"Grok changed no file\" with title \"Grok bot\"" || true
  exit "$status"
fi
git add -A
git -c user.name="Grok bot" -c user.email="grok-bot@localhost" -c commit.gpgsign=false \
  commit --quiet --no-verify -m "Grok bot: $(basename "$TASK" .md) ($STAMP)"
outside="$(git show --name-only --format= HEAD | grep -v '^web/e2e/' || true)"
tests="$(git show --name-only --diff-filter=AM --format= HEAD | grep -E '^web/e2e/.+\.e2e\.ts$' | sed 's#^web/##' || true)"

say "Changes on $BRANCH:"
git show --stat --format= HEAD
[ -z "$outside" ] || printf '\033[33m! Outside web/e2e (check these):\n%s\033[0m\n' "$outside"

# Grok's report is not evidence: its tests run again here, without its key
# and without network.
verdict="no new test files to check"
if [ -n "$tests" ]; then
  say "Running Grok's tests myself: $(echo $tests)"
  set +e
  docker run --rm "${hardening[@]}" --shm-size 1g --network none -e COREPACK_ENABLE_NETWORK=0 -e E2E_PHONE=1 \
    "${caches[@]}" "${mount_args[@]}" -w /work/web "$IMAGE" \
    corepack pnpm exec playwright test $tests > "$VERIFY" 2>&1
  vstatus=$?
  set -e
  tail -6 "$VERIFY"
  if [ "$vstatus" -eq 0 ]; then verdict="its tests pass"; else verdict="its tests FAIL (runs/$STAMP.verify.log)"; fi
fi
say "Result: $verdict"

cat <<HELP

Grok's report: .grok-bot/runs/$STAMP.report.md
Review from $REPO:
  git fetch .worktrees/grok-tests $BRANCH
  git diff HEAD...FETCH_HEAD
Take it over:
  git cherry-pick FETCH_HEAD
HELP
command -v osascript >/dev/null && osascript -e "display notification \"$BRANCH: $verdict\" with title \"Grok bot\"" || true
exit "$status"
