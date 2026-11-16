# Sourced by ../run.sh for `run.sh visual`: the screenshot sweep, then the
# review. For `run.sh visual-review` only the review, of the last sweep (or RUN=<folder in runs/>).
mkdir -p "$KIT/state"
[ -f "$KIT/accepted.txt" ] || printf '%s\n' \
  "# Findings that are fine as they are; the report's \"Fine as is\" button copies these lines." \
  "#   page <route> \"<quoted text>\"     # why" \
  "#   text <namespace> <key> <de|es>   # why" > "$KIT/accepted.txt"
[ -f "$KIT/review-notes.md" ] || printf '%s\n' \
  "# What Grok should know about the product: what is intended, who uses it." \
  "# Every line that is not a comment goes into each review." > "$KIT/review-notes.md"
COMMIT="$(git -C "$CLONE" log -1 --format='%h %s')"

if [ "$MODE" = review ]; then
  if [ -n "${RUN:-}" ]; then OUT="$KIT/runs/${RUN%/}"; else
    OUT="$(ls -td "$KIT"/runs/*-visual 2>/dev/null | while read -r d; do [ -d "$d/sweep" ] && echo "$d" && break; done)"
  fi
  [ -n "$OUT" ] && [ -d "$OUT/sweep" ] || die "No sweep to review: run .grok-bot/run.sh visual first."
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

# The previous run's findings, to mark what is new: the newest other run with a report.
PREV="$(ls -td "$KIT"/runs/2*-visual 2>/dev/null | while read -r d; do [ "$d" != "$OUT" ] && [ -f "$d/findings.json" ] && echo "$d" && break; done)"
prev_args=()
[ -n "$PREV" ] && prev_args=(-v "$PREV/findings.json:/previous.json:ro" -e PREVIOUS_NAME="$(basename "$PREV")")

# Grok sees only what review.mjs sends: the screenshots and the texts.
if [ "${AI:-1}" = 0 ]; then
  say "Review: automatic checks only (AI=0)"
  ai_args=(-e AI=0 --network none)
else
  say "Review by Grok, budget \$${MAX_USD:-2}"
  ai_args=(-e XAI_API_KEY)
fi
docker run --rm "${hardening[@]}" "${ai_args[@]}" \
  -e REVIEW_MODEL -e PAGE_MODEL -e TEXT_MODEL -e MAX_USD -e FULL -e REVIEW_VARIANTS -e PRICE_IN -e PRICE_OUT -e PRICE_CACHED \
  -e STAMP="$STAMP" -e COMMIT="$COMMIT" "${prev_args[@]+"${prev_args[@]}"}" \
  -v "$OUT:/out" -v "$KIT/state:/state" -v "$KIT/visual/review.mjs:/review.mjs:ro" -v "$KIT/accepted.txt:/accepted.txt:ro" -v "$KIT/review-notes.md:/notes.md:ro" -v "$CLONE/web/src:/src:ro" \
  "$IMAGE" node /review.mjs | tee "$OUT/review.log"

say "Report: .grok-bot/runs/$(basename "$OUT")/report.html"
# Unattended (scheduled.sh), the caller tells the person; nothing opens.
if [ -z "${UNATTENDED:-}" ]; then
  command -v open >/dev/null && open "$OUT/report.html" || true
  command -v osascript >/dev/null && osascript -e "display notification \"The visual review is ready\" with title \"Grok bot\"" || true
fi
exit 0
