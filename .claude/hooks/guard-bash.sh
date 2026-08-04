#!/usr/bin/env bash
# PreToolUse guard for Bash.
# Denies history-rewriting / work-destroying / publishing commands and pipe-to-shell.
# Escape hatch: CLAUDE_GUARD_OFF=1

set -uo pipefail

[[ -n "${CLAUDE_GUARD_OFF:-}" ]] && exit 0

input=$(cat)

deny() {
  jq -n --arg r "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

cmd=$(jq -r '.tool_input.command // empty' <<<"$input" 2>/dev/null)
[[ -z "$cmd" ]] && exit 0
cwd=$(jq -r '.cwd // empty' <<<"$input" 2>/dev/null)

set -f # no globbing while we tokenize untrusted command text

# Split a compound command into segments on ; && || | so a check only ever
# inspects the tokens belonging to the command it cares about.
segments() {
  printf '%s\n' "$1" | sed 's/&&/\n/g; s/||/\n/g; s/;/\n/g; s/|/\n/g'
}

# ---- git: skipping hooks ----------------------------------------------------
if grep -qE '\bgit\b[^|;&]*\bcommit\b' <<<"$cmd" \
  && grep -qE -- '(--no-verify|(^|[[:space:]])-n([[:space:]]|$)|-[a-zA-Z]*n[a-zA-Z]*[[:space:]])' <<<"$cmd"; then
  deny "Refusing 'git commit --no-verify'. The pre-commit hooks are what keep CodeRabbit/cubic quiet — fix what they flag instead of skipping them."
fi

# ---- git: force-push to a protected branch ----------------------------------
# Only protected when the refspec names main/master, or when no refspec is given
# and HEAD is on main/master. An explicit feature branch is fine to force-push.
while IFS= read -r seg; do
  grep -qE '\bgit\b.*\bpush\b' <<<"$seg" || continue
  grep -qE -- '(--force([^-]|$)|--force-with-lease|(^|[[:space:]])-f([[:space:]]|$))' <<<"$seg" || continue

  refspecs=()
  seen_push=0 seen_remote=0
  for tok in $seg; do
    [[ "$tok" == git ]] && continue
    [[ "$tok" == push ]] && { seen_push=1; continue; }
    [[ $seen_push -eq 0 ]] && continue
    [[ "$tok" == -* ]] && continue
    if [[ $seen_remote -eq 0 ]]; then seen_remote=1; continue; fi # remote name
    refspecs+=("$tok")
  done

  protected=0
  if [[ ${#refspecs[@]} -gt 0 ]]; then
    for ref in "${refspecs[@]}"; do
      [[ "$ref" =~ (^|[:/])(main|master)$ ]] && protected=1
    done
  else
    branch=$(git ${cwd:+-C "$cwd"} rev-parse --abbrev-ref HEAD 2>/dev/null || true)
    [[ "$branch" == "main" || "$branch" == "master" ]] && protected=1
  fi

  if [[ $protected -eq 1 ]]; then
    deny "Refusing to force-push to main/master. Push to a branch and open a PR; if history on main genuinely needs rewriting, do it yourself deliberately."
  fi
done < <(segments "$cmd")

# ---- git: destroying uncommitted work ---------------------------------------
if grep -qE '\bgit\b[^|;&]*\breset\b[^|;&]*--hard' <<<"$cmd"; then
  deny "Refusing 'git reset --hard' — it destroys uncommitted work I can't recover. If you want the tree reset, run it yourself, or let me 'git stash' first."
fi
if grep -qE '\bgit\b[^|;&]*\bcheckout\b[[:space:]]+(--[[:space:]]+)?(\.|\*)([[:space:]]|$)' <<<"$cmd"; then
  deny "Refusing 'git checkout .' — it silently discards every unstaged change. Name the specific file, or run it yourself."
fi
if grep -qE '\bgit\b[^|;&]*\bclean\b[^|;&]*-[a-zA-Z]*[fd]' <<<"$cmd"; then
  deny "Refusing 'git clean -fd' — it deletes untracked files (including .env and scratch work). Run it yourself if that's really what you want."
fi
if grep -qE '\bgit\b[^|;&]*\badd\b[^|;&]*(^|[[:space:]/])\.env([[:space:]]|$|\.)' <<<"$cmd" \
  && ! grep -qE '\.env\.(example|sample|template)' <<<"$cmd"; then
  deny "Refusing to stage a .env file. Those stay untracked; add the key to .env.example instead if the shape needs documenting."
fi

# ---- recursive delete outside the working tree -------------------------------
while IFS= read -r seg; do
  grep -qE '(^|[[:space:]])rm([[:space:]]|$)' <<<"$seg" || continue
  grep -qE -- '(^|[[:space:]])-[a-zA-Z]*[rR][a-zA-Z]*([[:space:]]|$)' <<<"$seg" || continue

  for tok in $seg; do
    [[ "$tok" == rm || "$tok" == -* ]] && continue
    case "$tok" in
      '~'|'~/'*|'$HOME'*|'"$HOME"'*|'*'|'/'|'.'|'..')
        deny "Refusing a recursive delete of '$tok'. Name a specific relative path inside the repo instead." ;;
      /*)
        if [[ -z "$cwd" || "$tok" != "$cwd"/* ]]; then
          deny "Refusing a recursive delete of '$tok' — it's outside the working directory (${cwd:-unknown}). Delete a path inside the repo, or run it yourself."
        fi ;;
    esac
  done
done < <(segments "$cmd")

# ---- publishing ------------------------------------------------------------
if grep -qE '\bnpm\b[^|;&]*\bpublish\b' <<<"$cmd" && ! grep -q -- '--dry-run' <<<"$cmd"; then
  deny "Refusing 'npm publish'. Releases go through changesets ('npm run release:version' / 'release:publish') and are a human decision."
fi

# ---- pipe-to-shell ---------------------------------------------------------
if grep -qE '(curl|wget)[^|;&]*\|[[:space:]]*(sudo[[:space:]]+)?(ba|z|)sh\b' <<<"$cmd"; then
  deny "Refusing to pipe a downloaded script straight into a shell. Fetch it to the scratchpad, read it, then run it."
fi

# ---- misc ------------------------------------------------------------------
if grep -qE '\bchmod\b[^|;&]*[[:space:]]777\b' <<<"$cmd"; then
  deny "Refusing 'chmod 777'. Use the narrowest mode that works (usually 'chmod +x' for a script)."
fi

exit 0
