# Task 4 Report: Credentialed Main-world Bridge and Isolated Client

## Status

Implemented and validated Task 4 in `/Users/bytedance/.codex/worktrees/repotreex-cnb-tree/repotreex`, on `feature/repotreex-cnb-tree`. No subagents were dispatched. All repository fixtures and fetch responses are synthetic; no signed-in session, cookies, or live CNB repository were accessed.

## Changed files

- `src/page/bridge.ts`: exported `handleBridgeRequest(request, fetchImpl)`; structural envelope/operation validation; Task 3 allowlist construction; exact credentialed GET options; successful JSON parsing; explicit sanitized HTTP/validation/network/abort errors; exact-origin bootstrap; extension-lifetime, once-only history patch and fixed navigation events.
- `src/content/bridge-client.ts`: exported `BridgeClient` and `createBridgeClient(window, channel, options?)`; UUID request correlation; strict response-envelope validation; metadata-limited errors; optional abort signals; 15-second default/configurable timeout; pending-map cleanup; idempotent disposal.
- `tests/bridge-client.test.ts`: 30 client cases covering correlation, malformed responses, codes, timeout, synchronous responses, abort, independent channels, disposal, timers, and listener cleanup.
- `tests/page-bridge.test.ts`: 47 cases covering all allowlisted operations, exact fetch options, HTTP/body privacy, invalid JSON, transport failures, malformed/disallowed inputs, event wiring, re-injection, native history descriptors/behavior, and client/handler round trips.
- `.superpowers/sdd/2026-11-07-repotreex-cnb-tree/task-4-report.md`: this report. Force-added because `.superpowers/sdd/.gitignore` ignores session reports by default; explicitly requested as a task deliverable.

No Task 3 protocol/error/allowlist changes, content bootstrap changes, manifest changes, new permissions, OAuth implementation, persistent repository storage, or cross-world teardown/cancellation protocol.

## TDD red/green evidence

Baseline, before test/code changes:

```text
npx --yes -p node@24 -c 'node --version && npm test'
v24.22.2
Test Files  4 passed (4)
Tests       67 passed (67)
Exit 0
```

Wrote the client and handler/lifetime tests before implementation, then ran the brief's focused red command:

```text
npx --yes -p node@24 -c 'npm test -- tests/bridge-client.test.ts tests/page-bridge.test.ts'
FAIL tests/bridge-client.test.ts: Failed to resolve import "../src/content/bridge-client"
FAIL tests/page-bridge.test.ts: Failed to resolve import "../src/content/bridge-client"
Test Files  2 failed (2)
Tests       no tests
Exit 1
```

This is the missing-implementation failure required by the brief: the client did not exist and `bridge.ts` contained only `export {};`. The round-trip test's dynamic client import caused Vite to fail both suites during transformation. It is not an assertion-only red run; that limitation is recorded explicitly.

After implementation, the first green attempt exposed test/runtime issues: Vitest requires an explicit `@vitest-environment jsdom` directive to associate per-file URL options with jsdom, and Vitest replaces global `window` with its global proxy while events retain the underlying jsdom Window as their target. The optional `event.target === window` filter (not required by the brief) prevented valid request/response delivery. Removed that filter, retained fixed event listeners and `CustomEvent`/shape validation, and corrected two ESLint multiline-call formatting errors. Two stuck test processes were stopped after bounded polling; no user files/processes were modified.

Focused green:

```text
npx --yes -p node@24 -c 'npm test -- tests/bridge-client.test.ts tests/page-bridge.test.ts && npm run typecheck && npm run lint'
Test Files  2 passed (2)
Tests       73 passed (73)
tsc --noEmit && tsc --noEmit -p tsconfig.tools.json: PASS
eslint src tests scripts: PASS
Exit 0
```

Self-review refined the response type guard to narrow error codes without a cast. Four additional tests characterize default timeout, channel independence, caller-supplied settings rejection, and inherited correlation rejection (already passing behaviors; not separate red cycles).

## Final validation: exact commands and outputs

All project commands used Node 24 via the required wrapper. Final integrated chain:

```text
npx --yes -p node@24 -c 'npm test -- tests/bridge-client.test.ts tests/page-bridge.test.ts && npm run typecheck && npm run lint && npm test && npm run build && npm run package' && git diff --check && unzip -t dist/repotreex-0.1.0.zip

> repotreex@0.1.0 test
> vitest run tests/bridge-client.test.ts tests/page-bridge.test.ts
Test Files  2 passed (2)
Tests       77 passed (77)
Duration    456ms

> repotreex@0.1.0 typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.tools.json
(no diagnostics)

> repotreex@0.1.0 lint
> eslint src tests scripts
(no diagnostics)

> repotreex@0.1.0 test
> vitest run
Test Files  6 passed (6)
Tests       144 passed (144)
Duration    668ms

> repotreex@0.1.0 build
> node scripts/build.mjs
dist/extension/page/bridge.js    8.1kb
dist/extension/content/index.js 29b
Done in 6ms

> repotreex@0.1.0 package
> node scripts/package.mjs
dist/extension/page/bridge.js    8.1kb
dist/extension/content/index.js 29b
Done in 7ms

git diff --check: no diagnostics
Archive: dist/repotreex-0.1.0.zip
testing: assets/icon-128.png OK
testing: assets/icon-16.png OK
testing: assets/icon-32.png OK
testing: assets/icon-48.png OK
testing: content/index.js OK
testing: manifest.json OK
testing: page/bridge.js OK
No errors detected in compressed data of dist/repotreex-0.1.0.zip.
Exit 0
```

Additional built-artifact smoke check (synthetic VM windows, no network):

```sh
npx --yes -p node@24 -c 'node --input-type=module -e '\''import {readFile} from "node:fs/promises"; import vm from "node:vm"; import assert from "node:assert/strict"; const source=await readFile("dist/extension/page/bridge.js","utf8"); let patches=0; class History { pushState(...args) { return args.length; } replaceState(...args) { return args.length; } } for (const origin of ["https://cnb.cool", "https://example.com"]) { const listeners=[]; const history=new History(); const sandbox={window:{location:{origin}, history, addEventListener:(...args)=>listeners.push(args), dispatchEvent:()=>true}, CustomEvent:class {}, URL, DOMException}; const context=vm.createContext(sandbox); const original=history.pushState; vm.runInContext(source,context); const first=history.pushState; vm.runInContext(source,context); assert.equal(history.pushState,first); assert.equal(listeners.length,origin==="https://cnb.cool"?3:0); assert.equal(first===original,origin!=="https://cnb.cool"); if (first!==original) patches++; } assert.equal(patches,1); console.log("Built bridge smoke: exact-origin install and idempotent history/listeners PASS");'\'''
```

```text
Built bridge smoke: exact-origin install and idempotent history/listeners PASS
Exit 0
```

Earlier full validation also passed 140 tests plus typecheck, lint, build, and package before adding the final four characterization tests.

## Self-review

- Request URL/method/credentials/headers/cache cannot be supplied across the bridge. Exact operation fields are required; `buildAllowedRequest` is the sole URL builder. `TypeError`/`URIError` during validation are mapped to `compatibility`; they cannot be mistaken for network failures because the catch scopes are separate.
- The fetch contract is verbatim: `GET`, `credentials: "include"`, `Accept: "application/json"`, `cache: "no-store"`. Runtime installation is gated to `https://cnb.cool`; manifest scope remains unchanged.
- Non-success bodies are never consumed. JSON syntax failures do not return HTML/text. Errors sent across worlds contain only channel, request ID, code, and numeric status, never body, headers, exception message/stack/cause, request URL, or operation metadata.
- `Retry-After` is deliberately not forwarded: the existing Task 3 `BridgeResponse` contract has no retry field, and the brief permits but does not require numeric retry metadata. No protocol redesign was necessary; even 429 errors remain exactly metadata-limited.
- Pending entries/timers/abort listeners are removed before callbacks settle on every normal outcome; disposing one client does not affect another. Late, wrong-channel, unknown-ID, malformed, and duplicate responses cannot settle active requests incorrectly.
- Success `data` remains `unknown` at the wire boundary. The single generic `data as T` conversion fulfills the requested caller-typed API; DTO semantic validation belongs to Task 5. Known error codes are narrowed by a type guard, with no `any` or double casts.
- Native history methods are replaced at their original descriptor owner, retaining flags, receiver, argument list, result, and thrown exceptions. Navigation emits only after successful calls, with no URL/state payload. Prototype and own-method paths plus re-injection are covered. Test cleanup stays in test code, not a production teardown API.
- No logging, analytics, cookies API, `document.cookie`, OAuth, storage calls, repository-data cache, or expanded host permissions were added. The bridge retains no repository data after settlement; the client retains only pending callbacks and cleanup state.
- Reviewed the complete changes against every brief step. No blocking implementation findings remain. Build/package outputs stay ignored. Branch and worktree are preserved; no merge, push, or PR action is authorized or performed.

## Concerns and boundaries

- Real Chrome/QQ Browser isolated/main-world interoperability and authenticated CNB behavior have not been tested; the round-trip integration is jsdom and the built smoke test is a VM. Live browser acceptance remains a later task.
- Abort, timeout, and disposal cancel client observation only. In-flight main-world fetches may complete and emit ignored responses because the protocol intentionally has no cross-world cancellation/teardown.
- CustomEvent channels provide correlation, not authentication against scripts already running on the same origin. Same-origin page scripts can observe/forge events; privilege is bounded by the fixed read-only allowlist and existing page session, not by channel secrecy.
- The exact prescribed fetch options leave native redirect behavior intact. An allowlisted CNB endpoint redirecting away from CNB is a server/browser behavior boundary not exercised here; changing redirect policy would change the specified contract.
- Unexpected non-validation/non-network/non-abort failures are rethrown, not disguised as success or a known code. A page-side unexpected rejection is surfaced by the browser; it is never copied into a response envelope or explicitly logged by this implementation.
- Content bootstrap remains the Task 1 stub until the planned controller/bootstrap task; this task delivers the consumable client module, not a mounted UI/provider.
- The configured pre-commit hook delegates to missing `script/pre_commit_checks.sh`. Required checks were run directly before committing; the commit result and any narrowly scoped bypass are recorded below.

## Commit outcome

The first commit attempt used the exact title `feat: reuse the active CNB web session`, with a scope/privacy/validation body. It failed with exit 1:

```text
bash: script/pre_commit_checks.sh: No such file or directory
```

All required direct validations above passed. The same staged task scope/title/body is therefore committed with the explicitly authorized `git commit --no-verify` retry. No hook/configuration file is changed. This report is included in that feature commit; its hash is returned by the commit command rather than embedded self-referentially in the report.
