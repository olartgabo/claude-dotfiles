# PreToolUse guard for Edit|Write|NotebookEdit (PowerShell implementation for Windows).
# Denies writes to generated/built artifacts, lockfiles, and .env files, denies
# literal secrets in file content, and warns when editing on main/master.
# Escape hatch: CLAUDE_GUARD_OFF=1
$ErrorActionPreference = 'SilentlyContinue'
if ($env:CLAUDE_GUARD_OFF) { exit 0 }

$raw = [Console]::In.ReadToEnd()
$data = $null
try { $data = $raw | ConvertFrom-Json } catch { exit 0 }
if (-not $data) { exit 0 }

function Deny([string]$reason) {
  $out = @{
    hookSpecificOutput = @{
      hookEventName = 'PreToolUse'
      permissionDecision = 'deny'
      permissionDecisionReason = $reason
    }
  }
  $out | ConvertTo-Json -Compress -Depth 5
  exit 0
}

function Warn([string]$context) {
  $out = @{
    hookSpecificOutput = @{
      hookEventName = 'PreToolUse'
      additionalContext = $context
    }
  }
  $out | ConvertTo-Json -Compress -Depth 5
  exit 0
}

$path = $data.tool_input.file_path
if (-not $path) { $path = $data.tool_input.notebook_path }
if (-not $path) { exit 0 }

$content = @()
$t = $data.tool_input
if ($t.content) { $content += [string]$t.content }
if ($t.new_string) { $content += [string]$t.new_string }
if ($t.new_source) { $content += [string]$t.new_source }
if ($t.edits) {
  foreach ($e in $t.edits) {
    if ($e.new_string) { $content += [string]$e.new_string }
  }
}
$content = $content -join "`n"

# ---- path denials -----------------------------------------------------------
$fileName = Split-Path -Leaf $path
if ($fileName -like '.env' -or $fileName -like '.env.*') {
  Deny "Refusing to write $path. Secrets and local env belong in a file you edit by hand, not one I generate. Tell me the variable name and I'll wire up process.env usage instead."
}

if ($path -match '(\\dist\\|\\build\\|\\out\\|\\coverage\\|\\.next\\|\\node_modules\\|\\client\\dist\\)' -or $path -match '(^|/)(dist|build|out|coverage|\.next|node_modules)(/|$)') {
  Deny "Refusing to write $path - that's build output. Edit the source (or the generator) and rebuild."
}
if ($fileName -match '\.(bundled|generated|min\.js|min\.css)$') {
  Deny "Refusing to write $path - that file is generated. Change the generator/source and re-run the bundle script so the artifact stays reproducible."
}
if ($fileName -eq 'package-lock.json' -or $fileName -eq 'pnpm-lock.yaml' -or $fileName -eq 'yarn.lock' -or $fileName -eq 'bun.lockb') {
  Deny "Refusing to hand-edit $path. Lockfiles are produced by the package manager - run the install command instead."
}

# ---- secret content denials -------------------------------------------------
if ($content) {
  $patterns = @(
    '-----BEGIN [A-Z ]*PRIVATE KEY-----',
    'sk-ant-[A-Za-z0-9_-]{16,}',
    '\b(ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}',
    'github_pat_[A-Za-z0-9_]{20,}',
    '\bAKIA[0-9A-Z]{16}\b',
    '\bxox[baprs]-[A-Za-z0-9-]{10,}'
  )
  foreach ($p in $patterns) {
    if ($content -match $p) {
      Deny "Refusing to write a literal credential into $path. Put the value in .env (untracked) and read it via process.env, then tell me the variable name."
    }
  }
}

# ---- main-branch advisory ---------------------------------------------------
$dir = Split-Path -Parent $path
if (Test-Path -LiteralPath $dir -PathType Container) {
  $branch = & git -C $dir rev-parse --abbrev-ref HEAD 2>$null
  if ($branch -eq 'main' -or $branch -eq 'master') {
    Warn "Heads up: this edit lands on '$branch'. Create a branch before continuing unless Gabriel explicitly asked to work on $branch."
  }
}

exit 0
