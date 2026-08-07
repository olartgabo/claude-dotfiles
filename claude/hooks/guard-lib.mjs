// Shared helpers for the PreToolUse guards.
//
// One implementation, run by `node`, so macOS/Linux/Windows teammates get
// byte-identical rules. No dependencies (Node 18+), no jq.

import os from "node:os";

export const ESCAPE_HATCH = "CLAUDE_GUARD_OFF";

// ---- hook I/O ---------------------------------------------------------------

export function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

export const deny = (reason) => ({ kind: "deny", reason });
export const warn = (reason) => ({ kind: "warn", reason });

export function respond(decision) {
  if (!decision) return;
  const payload =
    decision.kind === "deny"
      ? { permissionDecision: "deny", permissionDecisionReason: decision.reason }
      : { additionalContext: decision.reason };
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", ...payload },
    }),
  );
}

// A guard that crashes must never read as "allowed" silently, and must never
// wedge the session either: report the failure as context and let the call go.
export async function runHook(handler) {
  if (process.env[ESCAPE_HATCH]) return;
  let payload = {};
  try {
    payload = JSON.parse((await readStdin()) || "{}");
  } catch {
    return;
  }
  try {
    respond(handler(payload) ?? null);
  } catch (err) {
    respond(
      warn(
        `Guard hook ${process.argv[1]} failed to evaluate this call (${err?.message ?? err}). ` +
          `It was NOT checked — treat destructive commands as unguarded until the hook is fixed.`,
      ),
    );
  }
}

// ---- shell text --------------------------------------------------------------

// Cut a compound command into the individual commands it runs, so a check only
// ever inspects the tokens belonging to the command it cares about. Quote-aware:
// `git commit -m "a; b"` stays one segment.
export function splitSegments(command) {
  const cuts = new Set(["\n", ";", "|", "&", "(", ")", "`", "{", "}"]);
  const segments = [];
  let current = "";
  let quote = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        current += ch + command[++i];
        continue;
      }
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[++i];
      continue;
    }
    if (cuts.has(ch)) {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

// A backslash before a word character is a Windows path separator, not a shell
// escape — `C:\Windows` must survive tokenizing as `C:\Windows`, or every
// absolute Windows path collapses into a different one.
const SHELL_ESCAPABLE = /[^A-Za-z0-9_.\-]/;

// Split one segment into argv, dropping quotes. Quoted text becomes a single
// token, which is what keeps `git commit -m "add -n flag docs"` from looking
// like it passed `-n`.
export function tokenize(segment) {
  const tokens = [];
  let current = "";
  let started = false;
  let quote = null;
  const flush = () => {
    if (started) tokens.push(current);
    current = "";
    started = false;
  };

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (ch === "\\" && quote === '"' && SHELL_ESCAPABLE.test(segment[i + 1] ?? "")) {
        current += segment[++i];
        started = true;
        continue;
      }
      current += ch;
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === "\\" && i + 1 < segment.length) {
      if (SHELL_ESCAPABLE.test(segment[i + 1])) {
        current += segment[++i];
      } else {
        current += ch;
      }
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    current += ch;
    started = true;
  }
  flush();
  return tokens;
}

const WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "time",
  "nohup",
  "command",
  "nice",
  "ionice",
  "stdbuf",
  "xargs",
]);

export function baseName(p) {
  const slashed = String(p).replace(/\\/g, "/").replace(/\/+$/, "");
  const base = slashed.slice(slashed.lastIndexOf("/") + 1);
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "");
}

// The command actually being run, skipping `VAR=x` prefixes and wrappers like
// `sudo` / `env` / `xargs` so `sudo rm -rf /` is still an `rm`.
export function commandWord(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      i++;
      continue;
    }
    if (WRAPPERS.has(baseName(tok).toLowerCase())) {
      i++;
      while (i < tokens.length && tokens[i].startsWith("-")) i++;
      continue;
    }
    break;
  }
  if (i >= tokens.length) return { name: "", args: [] };
  return { name: baseName(tokens[i]).toLowerCase(), args: tokens.slice(i + 1) };
}

export function parseArgs(args) {
  const flags = [];
  const operands = [];
  let endOfOptions = false;
  for (const arg of args) {
    if (!endOfOptions && arg === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg.length > 1 && arg.startsWith("-")) {
      flags.push(arg);
      continue;
    }
    operands.push(arg);
  }
  return { flags, operands };
}

// `-rf` and `-r -f` and `--recursive` all have to read the same. Clustered short
// flags are the reason `-[a-zA-Z]*[rR]` style regexes leak.
export function hasShortFlag(flags, letter) {
  return flags.some(
    (f) => /^-[^-]/.test(f) && f.slice(1).split("=")[0].includes(letter),
  );
}

export function hasLongFlag(flags, ...names) {
  return flags.some((f) =>
    names.some((n) => f === `--${n}` || f.startsWith(`--${n}=`)),
  );
}

const GIT_GLOBAL_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
]);

// Returns the git subcommand plus its parsed args, or null if this segment is
// not a git invocation. Handles `git -C dir -c k=v commit …`.
export function parseGit(tokens) {
  const { name, args } = commandWord(tokens);
  if (name !== "git") return null;
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    i += GIT_GLOBAL_WITH_VALUE.has(args[i]) ? 2 : 1;
  }
  if (i >= args.length) return null;
  const rest = args.slice(i + 1);
  return { sub: args[i], rest, ...parseArgs(rest) };
}

// ---- paths -------------------------------------------------------------------

export function expandHome(p, home = os.homedir()) {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return `${home}/${p.slice(2)}`;
  return p
    .replace(/^\$HOME\b/, home)
    .replace(/^\$\{HOME\}/, home)
    .replace(/^%USERPROFILE%/i, home);
}

export function isAbsolutePath(p) {
  return /^([/\\]|[A-Za-z]:)/.test(p);
}

// Normalize to forward slashes and collapse `.` / `..`, resolving relative
// paths against cwd. This is what catches `rm -rf ../../..`.
export function resolvePath(cwd, p) {
  const base = String(cwd || "").replace(/[\\/]+$/, "");
  const raw = isAbsolutePath(p) ? p : `${base}/${p}`;
  const slashed = raw.replace(/\\/g, "/");
  const drive = /^([A-Za-z]:)/.exec(slashed);
  const prefix = drive ? drive[1] : "";
  const rest = drive ? slashed.slice(2) : slashed;
  const rooted = rest.startsWith("/");
  const out = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length) out.pop();
      continue;
    }
    out.push(part);
  }
  const joined = `${prefix}${rooted ? "/" : ""}${out.join("/")}`;
  return joined || (rooted ? "/" : ".");
}

export function samePath(a, b, caseInsensitive = process.platform === "win32") {
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// True when `child` sits strictly under `parent`.
export function isInside(
  parent,
  child,
  caseInsensitive = process.platform === "win32",
) {
  if (!parent) return false;
  const p = resolvePath("/", parent);
  const a = caseInsensitive ? p.toLowerCase() : p;
  const b = caseInsensitive ? child.toLowerCase() : child;
  return b.startsWith(a.endsWith("/") ? a : `${a}/`);
}

// ---- sensitive path classification ------------------------------------------
// Shared by the write guard and by the bash guard's redirection check, so
// `Write .env` and `echo … > .env` get the same answer.

const TEMPLATE_SUFFIX = /\.(example|sample|template)$/i;

const BUILD_DIRS = new Set([
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  ".turbo",
  "node_modules",
]);

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "deno.lock",
  "cargo.lock",
  "poetry.lock",
  "uv.lock",
  "gemfile.lock",
  "composer.lock",
]);

// Files whose whole job is to hold a credential.
const SECRET_FILES = [
  { match: (base) => base === ".env" || base.startsWith(".env."), what: "a .env file" },
  { match: (base) => base === ".envrc", what: "a direnv file (.envrc)" },
  { match: (base) => base === ".netrc" || base === "_netrc", what: "a .netrc" },
  { match: (base) => base === ".npmrc", what: "an .npmrc (it holds registry tokens)" },
  { match: (base) => base === ".pypirc", what: "a .pypirc" },
  { match: (base) => base === ".credentials.json", what: "a credentials file" },
  { match: (base) => base === "credentials", what: "a credentials file" },
  { match: (base) => /^id_(rsa|dsa|ecdsa|ed25519)$/.test(base), what: "an SSH private key" },
  { match: (base) => /\.(pem|key|p12|pfx|jks|keystore)$/.test(base), what: "a private key / keystore" },
  { match: (base) => /^service[-_]?account.*\.json$/.test(base), what: "a service-account key" },
];

const SECRET_DIRS = [
  { dir: ".ssh", what: "your SSH directory" },
  { dir: ".gnupg", what: "your GPG directory" },
  { dir: ".aws", what: "your AWS credentials directory" },
  { dir: ".kube", what: "your kubeconfig directory" },
];

export function pathSegments(p) {
  return String(p)
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s && s !== ".");
}

// Returns { kind, detail } or null. `kind` is one of:
// secret | build | generated | lockfile
export function classifyPath(p) {
  if (!p) return null;
  const segments = pathSegments(p);
  const base = (segments[segments.length - 1] ?? "").toLowerCase();

  // Committed templates are the documented way to describe a secret's shape.
  // This exempts the *path* only — the content scan still runs, so a real key
  // pasted into .env.example is still refused.
  const isTemplate = TEMPLATE_SUFFIX.test(base);

  if (!isTemplate) {
    for (const rule of SECRET_FILES) {
      if (rule.match(base)) return { kind: "secret", detail: rule.what };
    }
    for (const rule of SECRET_DIRS) {
      if (segments.some((s) => s.toLowerCase() === rule.dir)) {
        return { kind: "secret", detail: rule.what };
      }
    }
  }

  // Segment matching, not `*/dist/*` globbing: repo-root-relative `dist/a.js`
  // has to be caught as surely as `/proj/dist/a.js`.
  for (const segment of segments.slice(0, -1)) {
    if (BUILD_DIRS.has(segment.toLowerCase())) {
      return { kind: "build", detail: segment };
    }
  }

  if (
    base.includes(".bundled.") ||
    base.includes(".generated.") ||
    /\.min\.(js|mjs|cjs|css)$/.test(base)
  ) {
    return { kind: "generated", detail: base };
  }

  if (LOCKFILES.has(base)) return { kind: "lockfile", detail: base };

  return null;
}
