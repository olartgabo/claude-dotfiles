#!/usr/bin/env bash
# PreToolUse guard for Edit|Write|NotebookEdit.
# Denies writes to generated/built artifacts, lockfiles, and .env files, denies
# literal secrets in file content, and warns when editing on main/master.
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

warn() {
  jq -n --arg c "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: $c
    }
  }'
  exit 0
}

path=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' <<<"$input" 2>/dev/null)
[[ -z "$path" ]] && exit 0

content=$(jq -r '
  [ .tool_input.content?
  , .tool_input.new_string?
  , .tool_input.new_source?
  , (.tool_input.edits? // [] | .[]?.new_string?)
  ] | map(select(type == "string")) | join("\n")
' <<<"$input" 2>/dev/null)

# ---- path denials -----------------------------------------------------------
case "$path" in
  *.example|*.sample|*.template)
    : ;; # committed env templates are fine
  */.env|*/.env.*|.env|.env.*)
    deny "Refusing to write $path. Secrets and local env belong in a file you edit by hand, not one I generate. Tell me the variable name and I'll wire up process.env usage instead." ;;
esac

case "$path" in
  */dist/*|*/build/*|*/out/*|*/coverage/*|*/.next/*|*/node_modules/*|*/client/dist/*)
    deny "Refusing to write $path — that's build output. Edit the source (or the generator) and rebuild; this repo enforces it with 'npm run check:bundled-runtime-paths'." ;;
  *.bundled.*|*.generated.*|*.min.js|*.min.css)
    deny "Refusing to write $path — that file is generated. Change the generator/source and re-run the bundle script (see scripts/bundle-*.mjs) so the artifact stays reproducible." ;;
  */package-lock.json|package-lock.json|*/pnpm-lock.yaml|*/yarn.lock|*/bun.lockb)
    deny "Refusing to hand-edit $path. Lockfiles are produced by the package manager — run the install command instead (this repo uses 'npm install --legacy-peer-deps')." ;;
esac

# ---- secret content denials -------------------------------------------------
if [[ -n "$content" ]]; then
  if grep -qE -- '-----BEGIN [A-Z ]*PRIVATE KEY-----' <<<"$content" \
    || grep -qE 'sk-ant-[A-Za-z0-9_-]{16,}' <<<"$content" \
    || grep -qE '\b(ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}' <<<"$content" \
    || grep -qE 'github_pat_[A-Za-z0-9_]{20,}' <<<"$content" \
    || grep -qE '\bAKIA[0-9A-Z]{16}\b' <<<"$content" \
    || grep -qE '\bxox[baprs]-[A-Za-z0-9-]{10,}' <<<"$content"; then
    deny "Refusing to write a literal credential into $path. Put the value in .env (untracked) and read it via process.env, then tell me the variable name."
  fi
fi

# ---- main-branch advisory ---------------------------------------------------
dir=$(dirname "$path")
if [[ -d "$dir" ]]; then
  branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  if [[ "$branch" == "main" || "$branch" == "master" ]]; then
    warn "Heads up: this edit lands on '$branch'. Create a branch before continuing unless Gabriel explicitly asked to work on $branch."
  fi
fi

exit 0
