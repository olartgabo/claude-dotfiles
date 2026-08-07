#!/usr/bin/env node
// PreToolUse guard for Edit|Write|NotebookEdit.
//
// Denies writes to credential files, build output, generated artifacts and
// lockfiles; denies literal secrets in file content; warns when the edit lands
// on main/master. Escape hatch: CLAUDE_GUARD_OFF=1.
//
// The decision logic is a pure function so tests/guards.test.mjs can drive it
// with adversarial input. Every rule below has a fixture there.

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyPath, deny, pathSegments, runHook, warn } from "./guard-lib.mjs";

// Matched text containing one of these is documentation, not a leak — vendor
// docs and READMEs are full of key-shaped strings ending in EXAMPLE.
const PLACEHOLDER = /EXAMPLE|REDACTED|PLACEHOLDER|CHANGE[-_]?ME|YOUR[-_]|DUMMY|FAKE|X{6,}|\.\.\./i;

// Passwords that are obviously stand-ins, so connection-string docs stay writable.
const FAKE_PASSWORD =
  /^(pass(word)?|secret|changeme|postgres|root|admin|hunter2|x+|\*+|<[^>]*>|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_]+%)$/i;

const SECRET_PATTERNS = [
  { name: "a PEM private key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: "an Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{16,}/ },
  {
    name: "an OpenAI API key",
    re: /sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}/,
  },
  { name: "a GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/ },
  { name: "a GitHub fine-grained token", re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: "an AWS access key id", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  {
    name: "an AWS secret access key",
    re: /aws_?secret_?access_?key["'\s]*[=:]\s*["']?([A-Za-z0-9/+=]{40})\b/i,
  },
  { name: "a Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "a Google OAuth client secret", re: /\bGOCSPX-[A-Za-z0-9_-]{20,}/ },
  { name: "a Stripe live key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/ },
  { name: "a Stripe webhook secret", re: /\bwhsec_[A-Za-z0-9]{24,}/ },
  {
    name: "a Slack token",
    re: /\bxox[baprse]-[A-Za-z0-9-]{10,}|\bxapp-\d-[A-Za-z0-9-]{10,}/,
  },
  {
    name: "an npm registry token",
    re: /\b_?authToken\s*=\s*["']?(?:npm_)?[A-Za-z0-9_-]{20,}/i,
  },
  { name: "an npm access token", re: /\bnpm_[A-Za-z0-9]{30,}/ },
  { name: "a Hugging Face token", re: /\bhf_[A-Za-z0-9]{30,}/ },
  { name: "a SendGrid key", re: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/ },
  {
    name: "a Convex deploy key",
    re: /\b(?:prod|dev):[a-z-]+-\d+\|[A-Za-z0-9]{40,}/,
  },
];

const CONNECTION_STRING =
  /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis[s]?|amqps?|mssql|clickhouse):\/\/([^\s:@/]+):([^\s:@/]+)@/gi;

// Returns { name, match } for the first real-looking credential in `content`.
export function findSecret(content) {
  if (!content) return null;

  for (const { name, re } of SECRET_PATTERNS) {
    const match = re.exec(content);
    if (match && !PLACEHOLDER.test(match[0])) return { name, match: match[0] };
  }

  for (const match of content.matchAll(CONNECTION_STRING)) {
    const [full, , , password] = match;
    if (!FAKE_PASSWORD.test(password) && !PLACEHOLDER.test(full)) {
      return { name: "a connection string with an inline password", match: full };
    }
  }

  return null;
}

const REASONS = {
  secret: (path, detail) =>
    `Refusing to write ${path} — that's ${detail}. Credentials belong in a file you edit by hand, not one I generate. Tell me the variable name and I'll wire up the code that reads it.`,
  build: (path, detail) =>
    `Refusing to write ${path} — '${detail}/' is build output. Edit the source (or the generator) and rebuild, so the artifact stays reproducible.`,
  generated: (path) =>
    `Refusing to write ${path} — that file is generated. Change the generator or its input and re-run the build script.`,
  lockfile: (path) =>
    `Refusing to hand-edit ${path}. Lockfiles are produced by the package manager — run the install command instead.`,
};

export function checkWrite({ path, content, branch = null }) {
  if (!path) return null;

  const classified = classifyPath(path);
  if (classified) {
    return deny(REASONS[classified.kind](path, classified.detail));
  }

  // Runs even for '.example' templates: the path exemption says "this filename
  // is allowed to describe a secret", not "this file may contain one".
  const secret = findSecret(content);
  if (secret) {
    return deny(
      `Refusing to write ${secret.name} into ${path}. Put the value in an untracked .env and read it from the environment, then tell me the variable name.`,
    );
  }

  if (branch && ["main", "master"].includes(branch)) {
    return warn(
      `Heads up: this edit lands on '${branch}'. Create a branch before continuing unless the user explicitly asked to work on ${branch}.`,
    );
  }

  return null;
}

// Walk up to the nearest directory that exists — the target file's parent may
// not have been created yet.
function nearestExistingDir(path) {
  const segments = pathSegments(path);
  const prefix = /^[A-Za-z]:/.test(path) ? "" : path.startsWith("/") ? "/" : "";
  for (let i = segments.length - 1; i > 0; i--) {
    const candidate = prefix + segments.slice(0, i).join("/");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function branchOf(path) {
  const dir = nearestExistingDir(path);
  if (!dir) return null;
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function editedContent(toolInput = {}) {
  const parts = [
    toolInput.content,
    toolInput.new_string,
    toolInput.new_source,
    ...(Array.isArray(toolInput.edits) ? toolInput.edits.map((e) => e?.new_string) : []),
  ];
  return parts.filter((p) => typeof p === "string").join("\n");
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
    const input = payload?.tool_input ?? {};
    const path = input.file_path || input.notebook_path;
    if (!path) return null;
    return checkWrite({
      path,
      content: editedContent(input),
      branch: branchOf(path),
    });
  });
}
