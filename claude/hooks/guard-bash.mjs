#!/usr/bin/env node
// PreToolUse guard for shell tools (Bash, PowerShell).
//
// Denies history-rewriting, work-destroying and publishing commands, writes to
// credential files, and pipe-to-shell. Escape hatch: CLAUDE_GUARD_OFF=1.
//
// The decision logic is a pure function so tests/guards.test.mjs can drive it
// with adversarial input. Every rule below has a fixture there.

import os from "node:os";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  baseName,
  classifyPath,
  commandWord,
  deny,
  expandHome,
  hasLongFlag,
  hasShortFlag,
  isInside,
  parseArgs,
  parseGit,
  resolvePath,
  runHook,
  samePath,
  splitSegments,
  tokenize,
} from "./guard-lib.mjs";

const PROTECTED = new Set(["main", "master"]);

const DELETE_COMMANDS = new Set([
  "rm",
  "del",
  "erase",
  "rd",
  "rmdir",
  "remove-item",
  "ri",
  "unlink",
]);

const WRITE_REDIRECT = />>?\s*("[^"]+"|'[^']+'|[^\s;|&<>]+)/g;

const WRITE_CMDLETS = new Set([
  "set-content",
  "out-file",
  "add-content",
  "tee",
  "sc",
  "ac",
]);

function refspecs(operands) {
  // operands[0] is the remote; everything after it is a refspec.
  return operands.slice(1).map((raw) => {
    const forced = raw.startsWith("+");
    const spec = forced ? raw.slice(1) : raw;
    const colon = spec.indexOf(":");
    const dst = colon === -1 ? spec : spec.slice(colon + 1);
    return {
      forced,
      deletes: colon === 0,
      dst: dst.replace(/^refs\/heads\//, ""),
    };
  });
}

function checkGit(git, headBranch) {
  const { sub, flags, operands, rest } = git;

  // ---- skipping the pre-commit hooks ---------------------------------------
  if (
    (sub === "commit" || sub === "push" || sub === "merge") &&
    (hasLongFlag(flags, "no-verify") || hasShortFlag(flags, "n"))
  ) {
    return deny(
      `Refusing 'git ${sub} --no-verify'. The pre-commit hooks are what keep the review bots quiet — fix what they flag instead of skipping them.`,
    );
  }

  // ---- force-push / ref deletion on a protected branch ---------------------
  if (sub === "push") {
    if (hasLongFlag(flags, "mirror")) {
      return deny(
        "Refusing 'git push --mirror'. It force-updates and deletes remote refs wholesale. Push the branch you mean by name.",
      );
    }
    const specs = refspecs(operands);
    const flagForce =
      hasLongFlag(flags, "force", "force-with-lease") || hasShortFlag(flags, "f");
    const flagDelete = hasLongFlag(flags, "delete") || hasShortFlag(flags, "d");

    // `git push origin +main` is a force push with no --force anywhere.
    const targets = specs.length
      ? specs.filter((s) => s.forced || s.deletes || flagForce || flagDelete)
      : flagForce || flagDelete
        ? [{ dst: headBranch() }]
        : [];

    for (const target of targets) {
      const branch = baseName(target.dst ?? "");
      if (PROTECTED.has(branch)) {
        return deny(
          `Refusing to force-push or delete '${branch}' on the remote. Push to a branch and open a PR; if history on ${branch} genuinely needs rewriting, do it yourself deliberately.`,
        );
      }
    }
  }

  // ---- destroying uncommitted work ----------------------------------------
  if (sub === "reset" && hasLongFlag(flags, "hard")) {
    return deny(
      "Refusing 'git reset --hard' — it destroys uncommitted work I can't recover. If you want the tree reset, run it yourself, or let me 'git stash' first.",
    );
  }

  const WHOLE_TREE = new Set([".", "*", "./", ":/", "*.*"]);
  if (sub === "checkout" || sub === "restore") {
    if (operands.some((o) => WHOLE_TREE.has(o))) {
      return deny(
        `Refusing 'git ${sub} ${operands.find((o) => WHOLE_TREE.has(o))}' — it silently discards every unstaged change. Name the specific file, or run it yourself.`,
      );
    }
    if (hasLongFlag(flags, "force") || hasShortFlag(flags, "f")) {
      return deny(
        `Refusing 'git ${sub} --force' — it overwrites local modifications without a trace. Commit or stash first, then switch.`,
      );
    }
  }

  if (sub === "clean") {
    const dryRun = hasLongFlag(flags, "dry-run") || hasShortFlag(flags, "n");
    if (
      !dryRun &&
      (hasLongFlag(flags, "force") ||
        hasShortFlag(flags, "f") ||
        hasShortFlag(flags, "d") ||
        hasShortFlag(flags, "x"))
    ) {
      return deny(
        "Refusing 'git clean -fd' — it deletes untracked files (including .env and scratch work). Run it yourself if that's really what you want.",
      );
    }
  }

  if (sub === "stash" && ["clear", "drop"].includes(rest[0])) {
    return deny(
      `Refusing 'git stash ${rest[0]}' — stashes aren't reachable after that. Use 'git stash list' / 'git stash show' to find what you want, or run it yourself.`,
    );
  }

  if (sub === "filter-branch" || sub === "filter-repo") {
    return deny(
      `Refusing 'git ${sub}' — it rewrites every commit it touches. That's a deliberate human operation.`,
    );
  }

  if (sub === "reflog" && rest[0] === "expire") {
    return deny(
      "Refusing 'git reflog expire' — the reflog is the last way back from a bad reset. Leave it alone.",
    );
  }

  // ---- staging a credential file ------------------------------------------
  if (sub === "add" || sub === "stage") {
    for (const operand of operands) {
      if (classifyPath(operand)?.kind === "secret") {
        return deny(
          `Refusing to stage ${operand}. Credential files stay untracked; add the key name to a '.example' template instead if the shape needs documenting.`,
        );
      }
    }
  }

  return null;
}

function checkDelete(tokens, { cwd, home, caseInsensitive }) {
  const { name, args } = commandWord(tokens);
  if (!DELETE_COMMANDS.has(name)) return null;

  // No recursion precondition. `--recursive`, `-rf`, `-R`, `/s` and PowerShell's
  // `-Recurse` all mean the same thing, and getting that detection wrong used to
  // skip every path check below it. A non-recursive delete of /etc/passwd is not
  // fine either, so the paths are always checked.
  const { operands } = parseArgs(args);
  for (const operand of operands) {
    if (/^\/[a-zA-Z]$/.test(operand)) continue; // a DOS switch (`rd /s /q`), not a path
    const expanded = expandHome(operand, home);
    const literal = operand.replace(/\/+$/, "");

    if (["~", "/", ".", "..", "*", "/*", "$HOME", "%USERPROFILE%"].includes(literal)) {
      return deny(
        `Refusing to delete '${operand}'. Name a specific path inside the repo instead.`,
      );
    }

    const resolved = resolvePath(cwd, expanded);
    if (samePath(resolved, home, caseInsensitive)) {
      return deny(
        `Refusing to delete '${operand}' — that's your home directory.`,
      );
    }
    if (cwd && samePath(resolved, resolvePath("/", cwd), caseInsensitive)) {
      return deny(
        `Refusing to delete '${operand}' — that's the working directory itself (${cwd}). Delete a path inside it.`,
      );
    }
    if (!cwd || !isInside(cwd, resolved, caseInsensitive)) {
      return deny(
        `Refusing to delete '${operand}' — it resolves to ${resolved}, outside the working directory (${cwd || "unknown"}). Delete a path inside the repo, or run it yourself.`,
      );
    }
  }
  return null;
}

function checkWriteTargets(segment, tokens) {
  const targets = [];
  for (const match of segment.matchAll(WRITE_REDIRECT)) {
    targets.push(match[1].replace(/^["']|["']$/g, ""));
  }
  const { name, args } = commandWord(tokens);
  if (WRITE_CMDLETS.has(name)) targets.push(...parseArgs(args).operands);

  for (const target of targets) {
    if (classifyPath(target)?.kind === "secret") {
      return deny(
        `Refusing to write ${target} from the shell. Secrets belong in a file you edit by hand — tell me the variable name and I'll wire up the code that reads it.`,
      );
    }
  }
  return null;
}

export function checkShellCommand({
  command,
  cwd = process.cwd(),
  home = os.homedir(),
  headBranch = () => null,
  caseInsensitive = process.platform === "win32",
}) {
  if (!command) return null;

  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment);
    if (!tokens.length) continue;

    const git = parseGit(tokens);
    if (git) {
      const decision = checkGit(git, headBranch);
      if (decision) return decision;
    }

    const deleted = checkDelete(tokens, { cwd, home, caseInsensitive });
    if (deleted) return deleted;

    const written = checkWriteTargets(segment, tokens);
    if (written) return written;

    const { name, args } = commandWord(tokens);
    if (name === "npm" && args.includes("publish") && !args.includes("--dry-run")) {
      return deny(
        "Refusing 'npm publish'. Releases go through changesets and are a human decision.",
      );
    }
    if (name === "chmod" && args.some((a) => /^[0-7]?777$/.test(a))) {
      return deny(
        "Refusing 'chmod 777'. Use the narrowest mode that works (usually 'chmod +x' for a script).",
      );
    }
  }

  // Pipe-to-shell spans segments, so it is matched against the whole command.
  const pipeToShell = [
    /\b(curl|wget)\b[^|;&]*\|\s*(?:(?:sudo|doas|env)\s+[^|]*?)?(?:ba|z|k|)sh\b/i,
    /\b(curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:python3?|node|perl|ruby|pwsh|powershell)\b/i,
    /\b(?:ba|z|)sh\b[^|;&]*<\(\s*(?:curl|wget)\b/i,
    /\b(?:iex|invoke-expression)\b[^|;&]*(?:iwr|invoke-webrequest|invoke-restmethod|downloadstring)/i,
    /(?:iwr|invoke-webrequest|invoke-restmethod)\b[^|;&]*\|\s*(?:iex|invoke-expression)\b/i,
  ];
  if (pipeToShell.some((re) => re.test(command))) {
    return deny(
      "Refusing to pipe a downloaded script straight into a shell. Fetch it to the scratchpad, read it, then run it.",
    );
  }

  return null;
}

function currentBranch(cwd) {
  return () => {
    try {
      return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: cwd || process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };
}

function invokedDirectly() {
  try {
    return (
      !!process.argv[1] &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  await runHook((payload) => {
    const command = payload?.tool_input?.command;
    const cwd = payload?.cwd || process.cwd();
    return checkShellCommand({ command, cwd, headBranch: currentBranch(cwd) });
  });
}
