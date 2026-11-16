#!/bin/bash
# Backs up this kit to its private GitHub repository: scripts, settings,
# accepted findings, notes and the review cache. runs/ (screenshots, reports,
# logs) stays on this Mac. Pushes with your own Git sign-in.
#
#   .grok-bot/backup.sh             commit what changed and push it
#   .grok-bot/backup.sh "message"   the same, with your own commit message
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE="${BACKUP_REMOTE:-https://github.com/tobias-klocker/grok-bot-ai-soc-frontend-testing.git}"
cd "$KIT"

if [ ! -d .git ]; then
  git init -q -b main
  git remote add origin "$REMOTE"
  echo "Connected .grok-bot to $REMOTE"
fi

git add -A
if git diff --cached --quiet; then
  echo "Nothing changed since the last backup."
else
  git commit -q -m "${1:-Backup $(date '+%Y-%m-%d %H:%M')}"
fi

# A repository created with a first commit (a README from GitHub) is joined
# once; where both have a file, this kit's version wins.
if git ls-remote --exit-code --heads origin main >/dev/null 2>&1; then
  git fetch -q origin main
  git merge-base --is-ancestor origin/main HEAD 2>/dev/null \
    || git merge -q --no-edit --allow-unrelated-histories -X ours origin/main
fi

if ! git push -q -u origin main; then
  echo "The push failed. Sign Git in to GitHub once (gh auth setup-git), then run this again." >&2
  exit 1
fi
echo "Backed up to $REMOTE ($(git log -1 --format='%h %s'))"
