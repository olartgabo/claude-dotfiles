#!/usr/bin/env node
// Installs the shared Claude Code config into your config dir.
//
//   node install.mjs [--dry-run] [--target <dir>]
//
// Properties this script is responsible for, because the old four-line shell
// recipe had none of them:
//
//   * It copies individual managed files. It never links or replaces the config
//     directory itself, so your transcripts, projects/, history and plans are
//     never inside anything this repo tracks.
//   * It backs up every file it is about to change, and tells you where.
//   * It merges settings.json instead of overwriting it, so your own model,
//     theme, permission-mode and plugin choices survive.
//   * It verifies afterwards that the installed hooks actually deny a known-bad
//     command, by running the literal command string from settings.json. A hook
//     with a wrong path exits non-zero, which Claude Code reads as "allowed" —
//     silently unguarded is the one outcome worth failing the install over.

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(fileURLToPath(import.meta.url));
const PAYLOAD = path.join(REPO, "claude");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const targetFlag = args.indexOf("--target");
const TARGET =
  targetFlag !== -1 && args[targetFlag + 1]
    ? path.resolve(args[targetFlag + 1])
    : process.env.CLAUDE_CONFIG_DIR
      ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
      : path.join(os.homedir(), ".claude");

const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const BACKUP = path.join(os.homedir(), `.claude-dotfiles-backup-${STAMP}`);

const summary = { created: [], updated: [], unchanged: [], backed_up: [] };
let backupUsed = false;

function say(...parts) {
  console.log(...parts);
}

function relTarget(p) {
  return path.relative(TARGET, p).split(path.sep).join("/");
}

function backup(file) {
  const dest = path.join(BACKUP, relTarget(file));
  if (DRY_RUN) {
    summary.backed_up.push(relTarget(file));
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
  summary.backed_up.push(relTarget(file));
  backupUsed = true;
}

function writeFile(dest, contents) {
  const exists = fs.existsSync(dest);
  if (exists && fs.readFileSync(dest, "utf8") === contents) {
    summary.unchanged.push(relTarget(dest));
    return;
  }
  if (exists) backup(dest);
  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, contents);
  }
  (exists ? summary.updated : summary.created).push(relTarget(dest));
}

// Everything under claude/ except settings.json (merged, not copied) and the
// *.example templates (they seed machine-local files instead).
function managedFiles(dir = PAYLOAD) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...managedFiles(full));
      continue;
    }
    if (entry.name.endsWith(".example")) continue;
    if (path.relative(PAYLOAD, full) === "settings.json") continue;
    out.push(full);
  }
  return out;
}

// ---- settings.json: merge, never clobber ------------------------------------

const isOurHook = (entry) =>
  (entry?.hooks ?? []).some((h) => /guard-(bash|write)\.(mjs|sh|ps1)/.test(h?.command ?? ""));

function mergeHooks(existing = {}, incoming = {}) {
  const merged = { ...existing };
  for (const [event, entries] of Object.entries(incoming)) {
    // Drop previous registrations of *our* guards (including old .sh/.ps1
    // paths) so re-running the installer is idempotent, and leave every other
    // hook the teammate configured alone.
    const kept = (merged[event] ?? []).filter((entry) => !isOurHook(entry));
    merged[event] = [...kept, ...entries];
  }
  return merged;
}

// Parsed before anything is written, so a settings.json we can't read stops the
// install instead of half-finishing it.
function readExistingSettings() {
  const dest = path.join(TARGET, "settings.json");
  if (!fs.existsSync(dest)) return {};
  const raw = fs.readFileSync(dest, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not a JSON object");
    }
    return parsed;
  } catch (err) {
    console.error(`Can't merge into ${dest}: ${err.message}`);
    console.error("Fix the JSON (or move the file aside) and run this again. Nothing was changed.");
    process.exit(1);
  }
}

function installSettings(existing) {
  const templatePath = path.join(PAYLOAD, "settings.json");
  const template = JSON.parse(
    fs
      .readFileSync(templatePath, "utf8")
      // The hook commands need an absolute path: `~` is not expanded by every
      // shell Claude Code may spawn, and a path that fails to resolve turns the
      // guards off without saying so. Forward slashes work on all three
      // platforms and need no JSON escaping.
      .replaceAll("{{CLAUDE_DIR}}", TARGET.split(path.sep).join("/")),
  );

  const dest = path.join(TARGET, "settings.json");
  const merged = {
    ...existing,
    hooks: mergeHooks(existing.hooks, template.hooks),
    enabledPlugins: { ...existing.enabledPlugins, ...template.enabledPlugins },
  };

  const preserved = Object.keys(existing).filter((k) => !["hooks", "enabledPlugins"].includes(k));
  writeFile(dest, `${JSON.stringify(merged, null, 2)}\n`);
  return { merged, preserved, dest };
}

// ---- self-test: prove the guards are live ------------------------------------

const PROBES = [
  {
    tool: "Bash",
    label: "a destructive git command",
    payload: { cwd: process.cwd(), tool_input: { command: "git reset --hard" } },
  },
  {
    tool: "Write",
    label: "a write to .env",
    payload: { cwd: process.cwd(), tool_input: { file_path: path.join(process.cwd(), ".env"), content: "A=1" } },
  },
];

// Matchers are regexes written by hand, so a teammate's malformed one must not
// take down the install.
function matches(matcher, tool) {
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return false;
  }
}

function selfTest(settings) {
  const failures = [];
  for (const probe of PROBES) {
    const entry = (settings.hooks?.PreToolUse ?? []).find(
      (e) => matches(e.matcher, probe.tool) && isOurHook(e),
    );
    if (!entry) {
      failures.push(`no guard registered for the ${probe.tool} tool`);
      continue;
    }
    for (const hook of entry.hooks) {
      let stdout = "";
      try {
        // Run the literal command string from settings.json through a shell,
        // the way Claude Code will.
        stdout = execSync(hook.command, {
          input: JSON.stringify(probe.payload),
          encoding: "utf8",
          env: { ...process.env, CLAUDE_GUARD_OFF: "" },
        });
      } catch (err) {
        failures.push(`${hook.command} exited ${err.status ?? "?"}: ${String(err.stderr).trim()}`);
        continue;
      }
      let decision = null;
      try {
        decision = JSON.parse(stdout || "{}")?.hookSpecificOutput?.permissionDecision;
      } catch {
        failures.push(`${hook.command} printed non-JSON: ${stdout.slice(0, 200)}`);
        continue;
      }
      if (decision !== "deny") {
        failures.push(`${hook.command} did not deny ${probe.label} (got ${decision ?? "no decision"})`);
      }
    }
  }
  return failures;
}

// ---- run --------------------------------------------------------------------

if (!fs.existsSync(PAYLOAD)) {
  console.error(`No payload at ${PAYLOAD}. Run this from a checkout of the dotfiles repo.`);
  process.exit(1);
}

try {
  execSync("node --version", { stdio: "ignore" });
} catch {
  console.error("`node` is not on PATH. The guard hooks are Node scripts; install Node 18+ first.");
  process.exit(1);
}

say(`${DRY_RUN ? "Would install" : "Installing"} into ${TARGET}`);
const existingSettings = readExistingSettings();
if (!DRY_RUN) fs.mkdirSync(TARGET, { recursive: true });

for (const file of managedFiles()) {
  const dest = path.join(TARGET, path.relative(PAYLOAD, file));
  writeFile(dest, fs.readFileSync(file, "utf8"));
}

const { merged, preserved } = installSettings(existingSettings);

const localExample = path.join(PAYLOAD, "CLAUDE.local.md.example");
const localDest = path.join(TARGET, "CLAUDE.local.md");
if (fs.existsSync(localExample) && !fs.existsSync(localDest)) {
  writeFile(localDest, fs.readFileSync(localExample, "utf8"));
}

for (const [label, files] of Object.entries(summary)) {
  if (files.length) say(`  ${label.replace("_", " ")}: ${files.join(", ")}`);
}
if (preserved.length) {
  say(`  kept your own settings keys: ${preserved.join(", ")}`);
}
if (backupUsed) {
  say(`  backup of everything replaced: ${BACKUP}`);
}

if (DRY_RUN) {
  say("\nDry run — nothing was written.");
  process.exit(0);
}

const failures = selfTest(merged);
if (failures.length) {
  console.error("\nThe guards are NOT working after install:");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    "\nTreat this session as unguarded until it's fixed. `npm test` in this repo checks the\n" +
      "guard logic itself; the failure above is about how they're wired into settings.json.",
  );
  process.exit(1);
}

say("\nGuards verified: a destructive git command and a .env write were both denied.");
say("Next:");
say(`  1. Fill in ${path.join(TARGET, "CLAUDE.local.md")} — your checkout path, shell, tooling.`);
say(`  2. Personal settings (model, effortLevel, theme, permissions.defaultMode) go in`);
say(`     ${path.join(TARGET, "settings.json")}; this installer only manages hooks and plugins.`);
say("  3. Restart Claude Code so it reloads config and hooks.");
