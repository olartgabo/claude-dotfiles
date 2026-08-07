# PreToolUse guard for Bash (PowerShell implementation for Windows).
# Denies history-rewriting / work-destroying / publishing commands and pipe-to-shell.
# Escape hatch: CLAUDE_GUARD_OFF=1
$ErrorActionPreference = 'SilentlyContinue'
if ($env:CLAUDE_GUARD_OFF) { exit 0 }

$raw = [Console]::In.ReadToEnd()
$data = $null
try { $data = $raw | ConvertFrom-Json } catch { exit 0 }
$cmd = $data.tool_input.command
if (-not $cmd) { exit 0 }
$cwd = $data.cwd

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

$segs = $cmd -split ';|\|\||&&|\|'

# ---- git: skipping hooks ----------------------------------------------------
if ($cmd -match '\bgit\b' -and $cmd -match '\bcommit\b' -and ($cmd -match '--no-verify' -or $cmd -match '(^|[^\w-])-n(\s|$)' -or $cmd -match '-\w*n\w*(\s|$)')) {
  Deny "Refusing 'git commit --no-verify'. The pre-commit hooks are what keep CodeRabbit/cubic quiet - fix what they flag instead of skipping them."
}

# ---- git: force-push to a protected branch ----------------------------------
foreach ($seg in $segs) {
  if ($seg -notmatch '\bgit\b.*\bpush\b') { continue }
  if ($seg -notmatch '(--force(?![-w])|--force-with-lease|(^|[^\w-])-f(\s|$))') { continue }
  if ($seg -match '(main|master)') {
    Deny "Refusing to force-push to main/master. Push to a branch and open a PR; if history on main genuinely needs rewriting, do it yourself deliberately."
  }
}

# ---- git: destroying uncommitted work ---------------------------------------
if ($cmd -match '\bgit\b[^|;&]*\breset\b[^|;&]*--hard') {
  Deny "Refusing 'git reset --hard' - it destroys uncommitted work I can't recover. If you want the tree reset, run it yourself, or let me 'git stash' first."
}
if ($cmd -match '\bgit\b[^|;&]*\bcheckout\b\s+(--\s+)?(\.|\*)(\s|$)') {
  Deny "Refusing 'git checkout .' - it silently discards every unstaged change. Name the specific file, or run it yourself."
}
if ($cmd -match '\bgit\b[^|;&]*\bclean\b[^|;&]*-[a-zA-Z]*[fd]') {
  Deny "Refusing 'git clean -fd' - it deletes untracked files (including .env and scratch work). Run it yourself if that's really what you want."
}
if ($cmd -match '\bgit\b[^|;&]*\badd\b[^|;&]*\.env(\s|$)') {
  if ($cmd -notmatch '\.env\.(example|sample|template)') {
    Deny "Refusing to stage a .env file. Those stay untracked; add the key to .env.example instead if the shape needs documenting."
  }
}

# ---- recursive delete outside the working tree ------------------------------
foreach ($seg in $segs) {
  if ($seg -notmatch '(^|\s)rm(\s|$)') { continue }
  if ($seg -notmatch '(^|\s)-[a-zA-Z]*[rR][a-zA-Z]*(\s|$)') { continue }
  $tokens = $seg -split '\s+'
  foreach ($tok in $tokens) {
    if ($tok -eq 'rm' -or $tok -like '-*') { continue }
    $expanded = $tok -replace '\$HOME', $env:USERPROFILE
    if ($expanded -eq '~' -or $expanded -like '~/*' -or $expanded -eq $env:USERPROFILE -or $expanded -like "$env:USERPROFILE/*") {
      Deny "Refusing a recursive delete of '$tok'. Name a specific relative path inside the repo instead."
    }
    if ($tok -eq '*' -or $tok -eq '/' -or $tok -eq '.' -or $tok -eq '..') {
      Deny "Refusing a recursive delete of '$tok'. Name a specific relative path inside the repo instead."
    }
    if ($tok -like '/*' -and -not $expanded.StartsWith($cwd)) {
      Deny "Refusing a recursive delete of '$tok' - it's outside the working directory. Delete a path inside the repo, or run it yourself."
    }
  }
}

# ---- publishing ------------------------------------------------------------
if ($cmd -match '\bnpm\b' -and $cmd -match '\bpublish\b' -and $cmd -notmatch '--dry-run') {
  Deny "Refusing 'npm publish'. Releases go through changesets and are a human decision."
}

# ---- pipe-to-shell ---------------------------------------------------------
if ($cmd -match '(curl|wget)[^|;&]*\|[^\|]*(sh|bash|pwsh|powershell)\b') {
  Deny "Refusing to pipe a downloaded script straight into a shell. Fetch it to the scratchpad, read it, then run it."
}

# ---- misc ------------------------------------------------------------------
if ($cmd -match '\bchmod\b[^|;&]*\s777\b') {
  Deny "Refusing 'chmod 777'. Use the narrowest mode that works (usually 'chmod +x' for a script)."
}

exit 0
