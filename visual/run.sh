# Sourced by ../run.sh for `run.sh visual`: the screenshot sweep, then the
# review. For `run.sh visual-review` only the review, of the last sweep (or
# RUN=<folder in runs/>). For `run.sh report` the report of the last run (or
# RUN=…) redrawn and served with working verdict buttons.
mkdir -p "$KIT/state"
[ -f "$KIT/verdicts.txt" ] || printf '%s\n' \
  "# Verdicts on findings; the report's buttons write these lines (README.md)." \
  "#   fine  page <route> \"<quoted text>\"              # intended as it is" \
  "#   wrong page <route> \"<quoted text>\"              # Grok misread the screenshot" \
  "#   fix   page <route> \"<quoted text>\"              # a real defect, known until it is gone" \
  "#   fine  text <namespace> <key> <de|es> \"<text>\"   # the text as it was decided on" > "$KIT/verdicts.txt"
[ -f "$KIT/review-notes.md" ] || printf '%s\n' \
  "# What Grok should know about the product: what is intended, who uses it." \
  "# Every line that is not a comment goes into each review." > "$KIT/review-notes.md"
COMMIT="$(git -C "$CLONE" log -1 --format='%h %s')"

# The run before this one with a report: what "new" is measured against. Runs are
# named by when they were taken, so a redraw of an older run never compares
# with a later one. Sets prev_args.
previous_args() {
  local prev
  prev="$(ls -d "$KIT"/runs/2*-visual 2>/dev/null | sort -r | while read -r d; do [[ "$d" < "$1" ]] && [ -f "$d/findings.json" ] && echo "$d" && break; done)"
  prev_args=()
  [ -z "$prev" ] || prev_args=(-v "$prev/findings.json:/previous.json:ro" -e "PREVIOUS_NAME=$(basename "$prev")")
}
# What review.mjs reads besides the run: the kit's scripts, the verdicts, the
# notes, the review cache and Claude's triage, the app's texts.
# Only the report's server writes verdicts.txt.
review_mounts=(-v "$KIT/visual:/visual:ro" -v "$KIT/review-notes.md:/notes.md:ro" -v "$CLONE/web/src:/src:ro")

if [ "$MODE" = review ] || [ "$MODE" = report ]; then
  if [ -n "${RUN:-}" ]; then OUT="$KIT/runs/${RUN%/}"; else
    OUT="$(ls -td "$KIT"/runs/*-visual 2>/dev/null | while read -r d; do [ -d "$d/sweep" ] && echo "$d" && break; done)"
  fi
  [ -n "$OUT" ] && [ -d "$OUT/sweep" ] || die "No sweep to review: run .grok-bot/run.sh visual first."
fi

if [ "$MODE" = report ]; then
  previous_args "$OUT"
  say "Redrawing .grok-bot/runs/$(basename "$OUT") with verdicts.txt and Claude's triage (no Grok, free)"
  docker run --rm "${hardening[@]}" --network none -e REDRAW=1 -e RUN_NAME="$(basename "$OUT")" -e PAGE_MODEL -e TEXT_MODEL -e REVIEW_VARIANTS \
    "${prev_args[@]+"${prev_args[@]}"}" -v "$OUT:/out" -v "$KIT/state:/state:ro" "${review_mounts[@]}" -v "$KIT/verdicts.txt:/verdicts.txt:ro" \
    "$IMAGE" node /visual/review.mjs | tail -5
  [ "${SERVE:-1}" = 1 ] || exit 0
  PORT="${PORT:-7317}"
  ( sleep 2; command -v open >/dev/null && open "http://127.0.0.1:$PORT/" ) &
  exec docker run --rm "${hardening[@]}" --name "grok-bot-report-$PORT" -p "127.0.0.1:$PORT:$PORT" -e PORT="$PORT" -e RUN_NAME="$(basename "$OUT")" \
    -e PAGE_MODEL -e TEXT_MODEL -e REVIEW_VARIANTS "${prev_args[@]+"${prev_args[@]}"}" \
    -v "$OUT:/out" -v "$KIT/state:/state:ro" "${review_mounts[@]}" -v "$KIT/verdicts.txt:/verdicts.txt" "$IMAGE" node /visual/serve.mjs
fi

if [ "$MODE" = review ]; then
  say "Reviewing the screenshots of .grok-bot/runs/$(basename "$OUT") again"
else
# RUN=<folder in runs/>: add these variants to that run's report.
OUT="$KIT/runs/${RUN:-$STAMP-visual}"
OUT="${OUT%/}"
mkdir -p "$OUT"

say "Screenshot sweep of every page, without network or AI (10–20 minutes; progress: tail -f .grok-bot/runs/$(basename "$OUT")/sweep.log)"
set +e
docker run --rm "${hardening[@]}" --shm-size 2g --network none -e COREPACK_ENABLE_NETWORK=0 \
  -e SWEEP_VARIANTS -e SWEEP_WORKERS -e SWEEP_ONLY "${caches[@]}" "${mount_args[@]}" \
  -v "$KIT/visual:/work/web/grok-visual:ro" -v "$OUT:/out" -w /work/web "$IMAGE" \
  corepack pnpm exec playwright test -c grok-visual/playwright.config.ts > "$OUT/sweep.log" 2>&1
sweep=$?
set -e
if [ ! -d "$OUT/sweep" ]; then
  tail -30 "$OUT/sweep.log"
  die "The sweep captured nothing; see .grok-bot/runs/$(basename "$OUT")/sweep.log"
fi
[ "$sweep" -eq 0 ] || say "The sweep did not finish cleanly (sweep.log); reviewing what it captured"
fi

previous_args "$OUT"

# Grok sees only what review.mjs sends: the screenshots and the texts.
if [ "${AI:-1}" = 0 ]; then
  say "Review: automatic checks and Grok's earlier reviews of unchanged screenshots (AI=0)"
  ai_args=(-e AI=0 --network none)
else
  say "Review by Grok, budget $([ "${MAX_USD:-2}" = none ] && echo "without a limit" || echo "\${MAX_USD:-2}")"
  ai_args=(-e XAI_API_KEY)
fi
docker run --rm "${hardening[@]}" "${ai_args[@]}" \
  -e REVIEW_MODEL -e PAGE_MODEL -e TEXT_MODEL -e MAX_USD -e FULL -e REVIEW_VARIANTS -e PRICE_IN -e PRICE_OUT -e PRICE_CACHED \
  -e STAMP="$STAMP" -e RUN_NAME="$(basename "$OUT")" -e COMMIT="$COMMIT" "${prev_args[@]+"${prev_args[@]}"}" \
  -v "$OUT:/out" -v "$KIT/state:/state" "${review_mounts[@]}" -v "$KIT/verdicts.txt:/verdicts.txt:ro" \
  "$IMAGE" node /visual/review.mjs | tee "$OUT/review.log"

# Claude suggests a verdict for each new finding (triage.sh); TRIAGE=0 leaves that to you.
if [ "${TRIAGE:-1}" = 1 ] && grep -qE "not yet: [1-9]" "$OUT/review.log"; then
  say "Claude triages the new findings"
  "$KIT/triage.sh" "$OUT" || say "Claude's triage did not finish: ask Claude to triage the last run"
fi

say "Report: .grok-bot/runs/$(basename "$OUT")/report.html (with working buttons: .grok-bot/run.sh report)"
# Unattended (scheduled.sh), the caller tells the person; nothing opens.
if [ -z "${UNATTENDED:-}" ]; then
  command -v open >/dev/null && open "$OUT/report.html" || true
  command -v osascript >/dev/null && osascript -e "display notification \"The visual review is ready\" with title \"Grok bot\"" || true
fi
exit 0
