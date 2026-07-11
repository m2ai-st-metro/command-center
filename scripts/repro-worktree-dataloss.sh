#!/usr/bin/env bash
# Repro for Q-20260708-0003: CMD worker-manager worktree-merge silently loses
# uncommitted subtask edits and records it as success.
#
# Run: bash scripts/repro-worktree-dataloss.sh
#
# Expected output:
#   OLD path => FAIL (demonstrates the bug)
#   NEW path => PASS (demonstrates the fix)
#   NO-OP    => PASS (correct no-op detection)

set -euo pipefail
RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
PASS=0; FAIL=0

TMPBASE=$(mktemp -d /tmp/cmd-repro-XXXXXXXX)
trap "rm -rf $TMPBASE" EXIT

setup_repo() {
  local REPO="$1"
  git init -q "$REPO"
  git -C "$REPO" config user.email "repro@test"
  git -C "$REPO" config user.name "Repro"
  echo "initial" > "$REPO/file.txt"
  git -C "$REPO" add file.txt
  git -C "$REPO" commit -q -m "initial"
}

# ── OLD behavior: bare merge, no snapshot (the bug) ──────────────────────────
echo "=== OLD: git merge --no-ff with no snapshot (bug) ==="
REPO_OLD="$TMPBASE/repo-old"
WT_OLD="$TMPBASE/wt-old"
setup_repo "$REPO_OLD"
git -C "$REPO_OLD" worktree add -q -b "cmd-wt-test" "$WT_OLD" HEAD

# Agent edits file but does NOT commit — simulates the common agent behavior
echo "agent edit" >> "$WT_OLD/file.txt"

# Old mergeWorktree: git merge with no snapshot first
git -C "$REPO_OLD" merge --no-ff "cmd-wt-test" -m "merge" -q 2>&1 || true

CONTENT=$(cat "$REPO_OLD/file.txt")
if echo "$CONTENT" | grep -q "agent edit"; then
  echo -e "${GREEN}PASS (unexpected)${NC}: agent edit somehow survived"
  PASS=$((PASS+1))
else
  echo -e "${RED}FAIL (expected — this is the bug)${NC}: agent edit LOST; git reported 'Already up to date'"
  FAIL=$((FAIL+1))
fi

# ── NEW behavior: snapshot then merge (the fix) ───────────────────────────────
echo ""
echo "=== NEW: snapshot uncommitted work before merge (fix) ==="
REPO_NEW="$TMPBASE/repo-new"
WT_NEW="$TMPBASE/wt-new"
setup_repo "$REPO_NEW"
git -C "$REPO_NEW" worktree add -q -b "cmd-wt-test" "$WT_NEW" HEAD

# Same agent edit, uncommitted
echo "agent edit" >> "$WT_NEW/file.txt"

# New mergeWorktree logic: snapshot dirty state first
DIRTY=$(git -C "$WT_NEW" status --porcelain)
if [ -n "$DIRTY" ]; then
  git -C "$WT_NEW" add -A
  git -C "$WT_NEW" commit -q -m "cmd-mt: snapshot uncommitted work" --no-verify
fi

# Real no-op check: only merge if branch has commits past HEAD
AHEAD=$(git -C "$REPO_NEW" rev-list --count "HEAD..cmd-wt-test")
if [ "$AHEAD" -eq 0 ]; then
  echo "No commits ahead of HEAD — true no-op (skipping merge)"
else
  git -C "$REPO_NEW" merge --no-ff "cmd-wt-test" -m "merge" -q
  CONTENT=$(cat "$REPO_NEW/file.txt")
  if echo "$CONTENT" | grep -q "agent edit"; then
    echo -e "${GREEN}PASS${NC}: agent edit preserved after merge"
    PASS=$((PASS+1))
  else
    echo -e "${RED}FAIL${NC}: agent edit still missing — fix did not work"
    FAIL=$((FAIL+1))
  fi
fi

# ── NO-OP detection: empty worktree branch ───────────────────────────────────
echo ""
echo "=== NO-OP: branch with no commits should not trigger merge ==="
REPO_NOP="$TMPBASE/repo-nop"
WT_NOP="$TMPBASE/wt-nop"
setup_repo "$REPO_NOP"
git -C "$REPO_NOP" worktree add -q -b "cmd-wt-nop" "$WT_NOP" HEAD

# No edits at all — clean worktree
DIRTY=$(git -C "$WT_NOP" status --porcelain)
if [ -n "$DIRTY" ]; then
  git -C "$WT_NOP" add -A
  git -C "$WT_NOP" commit -q -m "cmd-mt: snapshot uncommitted work" --no-verify
fi
AHEAD=$(git -C "$REPO_NOP" rev-list --count "HEAD..cmd-wt-nop")
if [ "$AHEAD" -eq 0 ]; then
  echo -e "${GREEN}PASS${NC}: empty worktree correctly detected as no-op (git merge skipped)"
  PASS=$((PASS+1))
else
  echo -e "${RED}FAIL${NC}: expected 0 commits ahead but got $AHEAD"
  FAIL=$((FAIL+1))
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
