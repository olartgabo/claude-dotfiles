---
name: review-lessons-mcpjam
description: Recursive error patterns distilled from 11,495 CodeRabbit + cubic-dev-ai review findings across 3,329 PRs of the MCPJam/inspector codebase (TypeScript/React/Hono/MCP SDK). Use whenever writing, editing, or reviewing TypeScript, React, Node, or MCP-server code — especially before asking the user to merge or ship — to check work against the recurring failure modes those bots flagged. Also use for self-review of AI-generated code, or when a user asks "review my code", "check for bugs", "why does this break", or "what do reviewers usually catch here". Focuses on high-signal P0/P1 classes (SSRF, authn/authz, concurrency races, resource leaks, zod/parse traps, TS compile breakers) with concrete do/don't guidance.
---

# MCPJam review lessons

Recurring defects found by automated reviewers across the MCPJam/inspector
monorepo. Use these as a pre-merge / self-review checklist. Every item below
recurred multiple times across PRs, so treat each as a default assumption
until proven otherwise in the code being touched.

Severity map used by the bots: P0 = Critical, P1 = Major, P2 = Medium, P3 =
Minor. Pay attention to anything that would be P0/P1.

---

## 1. SSRF & outbound-network guards (P0-heavy)

The single most repeated security class. Guarding an outbound fetch is NOT a
one-line hostname check.

- **DNS rebinding / TOCTOU:** validating DNS in one step then letting `fetch()`
  resolve again re-opens the hole. Return the vetted address and pin the
  connection to it (`PR 1557`, `PR 3411`).
- **IPv4-mapped IPv6 bypasses loopback/private checks:** `[::ffff:7f00:1]`,
  `[0:0:0:0:0:0:0:1]`, `::ffff:127.0.0.1` defeat naive `::1` / `127.0.0.1`
  matching. Normalize every IPv6 form and inspect the embedded IPv4 before
  allowing the connection (`PR 3184`, `PR 2094`, `PR 1432`). Also handle
  `0.0.0.0` and non-canonical forms.
- **Redirects bypass the guard:** a public URL can redirect into the private
  network. Either disable automatic redirects and validate each `Location`
  hop, or validate every hop; also strip Authorization/credential headers when
  the redirect origin changes (`PR 3715`, `PR 3379`).
- **CSP scheme-source parsing:** `javascript:`, `data:`, `blob:` use a single
  colon; keying on `"://"` returns `undefined` scheme and skips the guard
  entirely (`PR 2094`).
- **Validate user/provider-supplied base URLs before outbound use** — provider
  `baseUrl` copied verbatim into runtime config then fetched = SSRF to internal
  ranges (`PR 2604`, `PR 1240`, `PR 974`).
- **Path-suffixed and bare `host:port` CSP entries** slip past hostname guards;
  parse them properly (`PR 2094`, `PR 2103`).
- **`localhost` vs `127.0.0.1` are distinct origins** in OAuth/CORS. Keep them
  consistent across redirect URIs, CORS lists, and localhost checks; validate
  against the remote address, not just the Host header (`PR 780`, `PR 859`,
  `PR 1222`).
- **`frame-ancestors *`** when the intent is localhost-only framing = remote
  embedding (`PR 1029`).

## 2. Authn / authz (P0-heavy)

- **Never trust a caller-supplied workspaceId/orgId to resolve another org's
  credentials.** Prove membership before resolving config, or you get IDOR
  (`PR 1732`, `PR 3343`).
- **Do not authorize privileged actions from unverified JWT claims.** A
  bearer-token pass that "intentionally lets non-`sk_` tokens through" then
  trusts `sub`/`org_id` from a forged 3-part token is arbitrary-user access
  (`PR 2507`).
- **Middleware ordering can block intended clients** — e.g. a session auth
  middleware mounted before `/api/v1/*` breaks bearer clients (`PR 2500`).
- **`X-Forwarded-For` first IP is attacker-controlled** — taking it for rate
  limiting lets users spoof per-request and OOM your IP map (`PR 3201`).
- **Zod `z.object()` strips unknown fields by default.** A body-sourced field
  that isn't in the schema (or uses `.passthrough()`) is silently dropped —
  an auth policy field can vanish for every non-chatbox caller (`PR 3225`).
- **Session/OAuth handles must be unguessable and owner-bound** — `Date.now() +
  counter` IDs are enumerable (`PR 1781`).
- **Route a new capability through the same auth path as its sibling** — a
  sandbox/guest token scope that skips the guest-auth bearer path 401s or
  bypasses (`PR 1631`, `PR 2313`).
- **Stored-but-never-consulted flags** ("hasSession" written, never read) leave
  the race/guard they were meant to close wide open (`PR 1594`).

## 3. Injection & secret hygiene (P0-heavy)

- **Never interpolate untrusted strings into shell**, including GH Actions
  expressions like `${{ github.event.pull_request.head.ref }}` and
  `client_payload` — crafted refs execute on the runner (`PR 1801`).
- **Redaction must cover raw header forms and object properties**, not just
  bearer tokens: `Authorization: Basic`, `Cookie`, `Set-Cookie`, OAuth `code`,
  `codeVerifier`, and arbitrary `customHeaders` leak via traces/debug output
  (`PR 1768`, `PR 1787`, `PR 1905`). Don't classify by value shape — an
  uppercase/hyphenated opaque code is still a secret (`PR 1787`).
- **Escape values interpolated into generated HTML/scripts** (widget baseUrl,
  inline scripts, attributes) — quotes/backticks are an injection path
  (`PR 1768`).
- **`blob:` links opened in a new tab** from untrusted content are an unsafe
  navigation path; restrict to http(s) (`PR 2254`).
- **`__proto__` as a plain-object key** silently sets the prototype instead of
  storing a value — use `Map` or `Object.create(null)` (`PR 3518`).

## 4. Concurrency & async state (P0-heavy)

- **Serialize mutations that span `await` points.** `record`/`flush`/`finalize`
  racing = double-append, double-start, finalize-while-draining. Funnel through
  a single promise queue / mutex (`PR 1541`).
- **Single-flight must survive all paths.** Clearing `inFlightRequest` before
  the replacement promise is established reintroduces the refresh race
  (`PR 1575`); coalesce JWKS/cache refreshes so one expiry doesn't burst N
  upstream fetches (`PR 1621`).
- **Stale closures defeat async pipelines.** `persistRun` captured from an
  early render writes stale state even though later renders have fresh data
  (`PR 3715`). Check what the `.then()` callback actually closes over.
- **Promises that can never settle** (error path logs but never resolve/reject)
  hang callers forever — always settle in `finally` (`PR 1454`, `PR 1657`).
- **Fire-and-forget where the caller needs the result**: `onReconnect` typed
  `void` resets the spinner instantly; async callbacks with `void` discard
  rejections (`PR 1432`, `PR 2298`, `PR 2499`).
- **Canceled work must not resolve as success** (`PR 1730`), and in-flight
  saves must not be composed into a sibling save as stale data (`PR 1928`).
- **Roll back optimistic state when the write fails** (`PR 1634`), and guard
  against double-submit of non-idempotent writes (`PR 2060`).
- **Every outbound call needs a deadline** — upstream fetch with no timeout can
  hang a handler or stack up capacity (`PR 1583`, `PR 2554`, `PR 3046`,
  `PR 2123`, `PR 955`).

## 5. Resource lifecycle & cleanup

- **A spawned child/transport must be closed on connect failure**, not just
  annotated (`PR 1784`). Unmanaged stderr pipes stall child processes
  (`PR 1784`).
- **Guarantee teardown** even on the error path — stream handlers that skip
  cleanup on failure leak guest connections (`PR 1848`, `PR 1582`, `PR 1722`).
- **Caches/Maps need a bound and a prune** — rate-limit buckets keyed by
  attacker-controlled IDs grow without a sweep (`PR 1454`, `PR 1557`).
- **Polling must not overlap** — an interval that fires while the previous
  check is in flight piles up requests and marks responses stale (`PR 1605`).
- **Clear `Promise.race` timers on the winning branch** (`PR 1966`); unbounded
  listing loops caused by effect deps on reference identity re-fetch forever
  (`PR 3683`).

## 6. Parsing, validation & type/schema drift

- **Guard `JSON.parse` on storage/network input** with try/catch — corrupt
  `localStorage` values crash the component (`PR 1432`); `response.json()` on a
  non-2xx HTML/empty body throws before error mapping (`PR 1730`).
- **Keep Zod schema and TypeScript type in lockstep** — `args.args` nesting
  divergences fail validations at runtime (`PR 2371`); stripped fields silently
  disappear (`PR 3225`).
- **`atob` mangles multi-byte UTF-8** JWT/claim payloads — use a
  binary→UTF-8 pipeline (`TextDecoder`) (`PR 1432`).
- **Delimiter assumptions break identifiers**: provider names containing `:`
  corrupt `split(":")` model IDs (`PR 1447`); comma-splitting corrupts config
  values that legitimately contain commas (`PR 1750`); `split("/")` on
  namespaced names mis-parses multi-segment values (`PR 876`).
- **Validation conditions can be vacuously true/false** — `value && value.length`
  (no length check) never validates; check the logic actually tests what it
  claims (`PR 2412`).
- **Interface names must be validated**, not assumed (typo "anthropogenic" vs
  "anthropic" silently routes to the wrong provider code path, `PR 1447`).

## 7. TypeScript & compile-time breakers (P0 "quick win" class)

The cheapest class: flagged dozens of times as build blockers.

- Missing imports (icons, `useQuery`, `join`, `React`/`ReactNode`/`React.CSSProperties`,
  `Settings2`, `useResetComputer`...) and imports from a module that doesn't
  export the name (`PR 1541`, `PR 1583`, `PR 1730`, `PR 1793`, `PR 1937`,
  `PR 2130`, `PR 2249`, `PR 3418`).
- `InstanceType` used with a `type`-only import (no runtime value) — model the
  instance type directly (`PR 1762`, `PR 1768`).
- ESM pitfalls: `__dirname`/`require` used without defining them in a
  `"type": "module"` package (`PR 3139`, `PR 3527`).
- Duplicate `const` declarations in test scopes = Vitest won't even parse
  (`PR 2900`, `PR 2965`, `PR 3405`, `PR 3733`).
- Rules of Hooks: conditional `useLocation()`/`useParams()` behind early
  returns or runtime branches (`PR 2115`, `PR 3733`); `React.Foo` namespace
  types without importing React (`PR 2130`).
- Unresolved merge conflict markers, malformed duplicate type definitions
  (`PR 1689`, `PR 3265`); dependency declared in the wrong `package.json`
  (resolved against a different package root, `PR 1661`).
- Type/value mismatch on error checks: `string | null` error tested with
  `instanceof Error` never renders (`PR 1645`); tests asserting strings the
  component doesn't render (`PR 1915`).

## 8. React state, effects & rendering

- **Snapshot/reference aliasing**: keeping `initialValues` pointing at the same
  object graph as live state makes `hasChanges` comparisons always-equal and
  disables Save (`PR 1648`). Deep-copy baselines.
- **Effects that re-fetch because a descriptor array is rebuilt every render**
  cause unbounded request loops — memoize on a stable key (`PR 3683`).
- **`setState` after unmount** / state updated by a settled-but-stale async
  write after sign-out — cancel or guard with an abort/epoch token
  (`PR 1696`).
- **Readiness races in UI**: empty-subject mount crashes `configs[0]` reads
  before the empty-state branch runs (`PR 2907`); a loading status must be
  treated as running everywhere it's consumed (`PR 1729`).
- **Feature flags that don't gate navigation** land users on dead-ends
  (`PR 1722`); a route branch missing from the router makes a tab
  unreachable (`PR 1581`).
- **Event listeners / message handlers need `event.source` + origin
  validation** before trusting `window.postMessage` data (`PR 1768`).

## 9. Error handling

- **Don't swallow errors in empty `catch {}`** — surface them (`PR 874`).
  Log/limit error detail consistently (truncate details the same as messages,
  `PR 913`).
- **Guard before indexing/spreading possibly-undefined** — `...suite.environment`
  when undefined throws before run starts (`PR 2674`); `subjects[0]` when empty
  (`PR 2907`).
- **`finally` that throws masks the original error** (`PR 1756`); keep
  `onFinish` unconditional but persist only successful runs (`PR 1582`).
- **Don't let an error handler disable recovery** — `es.close()` inside
  `EventSource.onerror` kills built-in reconnect (`PR 874`).
- **Attach `.catch` to `void fn()` calls** to avoid unhandled rejections
  (`PR 1944`).

## 10. Testing

- **Mock the same method names the code calls** — stubbing `validateApiKey`
  while the code calls `createValidation` gives a false green (`PR 2507`).
- **Provide every hook from mocked modules** the component imports
  (`PR 3418`); give test factories defaults for required fields (`PR 1687`).
- **Assertions must match reality** — tests asserting strings/counters the
  component never renders fail the suite (`PR 1915`); tests that pass only by
  timing or skip the real path are false passes (`PR 3149`).
- **Mind ESM/Node globals** in tests (`__dirname`, `require`, `PR 3139`,
  `PR 3527`) and keep a single definition per scope (`PR 2900` etc.).
- **Update lockstep**: when implementation wording/behavior changes, the test
  expectation must move with it (`PR 2862`).

## 11. Config, deps & docs

- **Version ranges must exist on npm** — `^15.5.15` when latest is `15.5.9`
  blocks `npm ci` with ETARGET (`PR 1820`); beware dependency downgrades
  (`PR 877`).
- **Don't commit `node_modules` / symlinks with absolute paths** (`PR 2806`).
- **Wiring must match the bundle/artifact** — importing a `ChatboxProxyHtml`
  when the bundler emits `SandboxProxyHtml` breaks the build (`PR 1841`).
- **CSS custom properties must be defined** or the value resolves to `initial`
  (`PR 3528`); docs links that 404 (`PR 1687`); hardcoded limits that diverge
  from the plan catalog (`PR 2065`).

---

## Self-review checklist (run before merge / before declaring done)

1. Outbound fetch: pinned DNS? every redirect hop validated? credentials
   stripped on origin change? IPv6/mapped/`0.0.0.0` handled? scheme-source
   single-colon handled?
2. Auth: caller identity proven before privilege? no unverified JWT claims?
   new routes through the same auth path? rate limit not spoofable via
   X-Forwarded-For?
3. Secrets: redaction covers raw headers + object properties? no `shell`/
   HTML interpolation of untrusted input? no `blob:` nav?
4. Async: shared state across `await` serialized? single-flight on all paths?
   stale closures? every promise settles? every outbound call has a timeout?
5. Lifecycle: child processes/transports closed on failure? teardown runs on
   error path? Maps bounded/pruned? polling never overlaps?
6. Validation: `JSON.parse` guarded? Zod schema == TS type? UTF-8 decoded
   properly? no delimiter/identifier assumptions? validation logic actually
   tests what it claims?
7. Compile: imports exist and are exported? no `InstanceType` on type-only
   import? ESM globals (`__dirname`/`require`) defined? no duplicate
   declarations / merge markers / conditional hooks?
8. React: baselines deep-copied? effects memoized on stable keys? no state
   after unmount? empty/loading states guarded before indexing? message
   listeners validate `event.source` + origin?
9. Errors: no empty `catch {}`, guards before index/spread, `finally` doesn't
   mask, error path can't disable reconnect.
10. Tests: mocks match real call signatures, all imported hooks provided,
    assertions match actual rendering, expectations updated with behavior.
