# Task 7: Filename search and bounded full-tree loading

## Status

Implemented, validated, and self-reviewed in the existing
`feature/repotreex-cnb-tree` worktree, starting at `c5c2da8`. Work was confined
to `/Users/bytedance/.codex/worktrees/repotreex-cnb-tree/repotreex`.
No subagents, original-checkout edits, dependency changes, push, or live CNB
requests. All test fixtures are synthetic. Commit evidence is appended below.

## Changed files

- `src/content/search.ts`: pure loaded-node matching; typed, cancellable,
  FIFO traversal with bounded concurrency, discovery counting, progress, and
  explicit error propagation.
- `tests/search.test.ts`: 67 focused cases using the real tree store and
  normalized synthetic provider entries. One structural store fixture exercises
  duplicate/cyclic cached directory edges; one exercises synchronous throws.
- `.superpowers/sdd/2026-11-07-repotreex-cnb-tree/task-7-report.md`: this report.

## Interfaces and deliberate semantics

`matchLoadedNodes(snapshot, query)` returns `LoadedNodeMatches`, a subtype of
`TreeNode[]` with `hasMoreMatches: boolean`. This preserves the brief's array
interface (`map`, iteration, indexing) while exposing the required overflow
flag directly on the result. Trimmed empty/unmatched queries return an empty
array with `hasMoreMatches: false`. Results include all discovered non-root
entry kinds, even when hidden by collapsed directories; they do not require a
file's `loaded` flag, which denotes directory-listing completion in the store.
Matching uses locale-aware lowercase and literal substring comparison.
Ranking is basename prefix, basename substring, then full-path substring,
followed by path length, numeric/case-insensitive natural ordering, and a
deterministic case-equivalent lexical fallback. Rank before slicing to 200;
no query, snapshot, or result cache exists.

`loadFullTree` consumes only `loadDirectory` and `getSnapshot` through a
`Pick<TreeStore, ...>`. `TraversalOptions` has optional concurrency, maxNodes,
signal, and onProgress. `TraversalResult` contains loadedNodes, truncated,
and cancelled; progress contains only loadedNodes, queuedDirectories,
and activeRequests. No duplicate bridge DTO inspection or provider types.

Defaults are concurrency 4 and maxNodes 10,000. Counts include distinct
non-root nodes already in the cache as well as entries discovered by each
settled directory. Every entry kind counts; only directories enter the FIFO.
Visited-at-enqueue deduplicates duplicate/cyclic edges. Reaching the ceiling
exactly sets truncated; maxNodes 0 schedules nothing. Invalid non-safe-integer
limits (or concurrency < 1 / maxNodes < 0) reject with metadata-free RangeError.

At the ceiling, stop scheduling, do not abort outstanding store loads, and wait
for them to settle. Accounting saturates at maxNodes, including drain progress;
fatal errors during draining still reject unchanged. All already-settled
requests are processed before replenishing slots, preventing one extra request
when simultaneous successes reach the ceiling or a sibling has already failed.
On fatal errors, scheduling likewise stops and outstanding work drains.
Original unknown rejection values, including undefined, are propagated.
The narrow observer catch propagates observer failure rather than creating a
success result. A recorded fatal failure takes precedence over cancellation.

Progress emits a fresh three-number object after every processed successful or
failed directory settlement. Only loadedNodes is monotonic; queue and activity
naturally grow/shrink. At truncation a nonzero queuedDirectories value denotes
known pending directories deliberately not dispatched, not missing progress.

AbortSignal cancellation is prompt even if the underlying provider never
settles: no more scheduling or progress, listener detached, queues/sets cleared,
and pending request paths and settlement sinks nulled. Late successes/rejections
are observed but cannot retain/publish through traversal state. Store-provided
RepositoryError(cancelled), DOMException(AbortError), and Error named AbortError
translate to cancelled results. Store repo/ref/root-loaded checks guard dispatch
and settlement; actual session replacement cancels store-owned pending loads.

## TDD evidence

Using test-driven-development and verification-before-completion; the existing
plan supplied the approved design, so no new design/brainstorming scope or
subagent dispatch was introduced. Existing worktree isolation was checked with
`git rev-parse --git-dir --git-common-dir --show-superproject-working-tree`;
the git/common paths differed and no superproject was reported. Commit evidence
and style were collected first using
`/Users/bytedance/.codex/skills/git-commit/git-commit.sh`; branch was named,
status clean, staged/unstaged/untracked counts all zero.

Runtime and clean baseline:

```text
$ npx --yes -p node@24 -c 'node --version && npm --version && npm test'
v24.22.2
10.9.2
> repotreex@0.1.0 test
> vitest run
RUN v5.1.0
Test Files 8 passed (8)
Tests 468 passed (468)
Start at 14:12:00
Duration 853ms
Exit 0
```

Initial tests were written before search.ts. Required missing-module RED:

```text
$ npx --yes -p node@24 -c 'npm test -- tests/search.test.ts'
> repotreex@0.1.0 test
> vitest run tests/search.test.ts
RUN v5.1.0
FAIL tests/search.test.ts
Error: Failed to resolve import "../src/content/search" from "tests/search.test.ts". Does the file exist?
File: tests/search.test.ts:3:71
Test Files 1 failed (1)
Tests no tests
Start at 14:13:37
Duration 382ms
Exit 1
```

First GREEN after implementation:

```text
$ npx --yes -p node@24 -c 'npm test -- tests/search.test.ts && npm run typecheck && npm run lint'
Test Files 1 passed (1)
Tests 52 passed (52)
Start at 14:14:52
Duration 948ms
> tsc --noEmit && tsc --noEmit -p tsconfig.tools.json
> eslint src tests scripts
Exit 0
```

Self-review added ten cases before fixes. Three reproduced genuine defects:
queued microtasks could load after immediate abort/session replacement, and a
standard Error named AbortError was not recognized.

```text
$ npx --yes -p node@24 -c 'npm test -- tests/search.test.ts'
Tests 3 failed | 59 passed (62)
FAIL does not dispatch work when aborted immediately after the call
AssertionError: expected true to be false (replacement root loaded)
FAIL does not dispatch into a different session replaced immediately after the call
AssertionError: expected true to be false (replacement root loaded)
FAIL classifies an Error named AbortError as cancellation
AssertionError: promise rejected "AbortError: synthetic abort" instead of resolving
Start at 14:15:50
Duration 1.26s
Exit 1
```

Added the immediate pre-dispatch activity check and Error cancellation
classification. GREEN at 14:16:12: 62/62 focused, both typechecks, lint, exit 0.
Then added five cases, including two same-turn settlement regressions, before
the final scheduling fix:

```text
$ npx --yes -p node@24 -c 'npm test -- tests/search.test.ts'
Tests 2 failed | 65 passed (67)
FAIL counts all discovered nodes before refilling slots when two loads settle together
FAIL does not refill slots after a concurrent request has already failed
Both: expected calls [ '', 'a', 'b' ]; received [ '', 'a', 'b', 'c' ]
Start at 14:17:10
Duration 1.37s
Exit 1
```

Root cause: Promise.race processed one completed request before dispatching
another, although a second request had already completed/rejected. Replaced
per-iteration race registration with a per-call settlement inbox, detachable
request sinks, and one wake notification. Drain the completed batch before
refilling. GREEN at 14:17:51: 67/67 focused, both typechecks, lint, exit 0.
No test assertions were weakened and no production store/provider APIs changed.

## Exact final validation commands and outputs

Final focused/static validation after all source/test edits:

```text
$ npx --yes -p node@24 -c 'npm test -- tests/search.test.ts && npm run typecheck && npm run lint'
> repotreex@0.1.0 test
> vitest run tests/search.test.ts
RUN v5.1.0 /Users/bytedance/.codex/worktrees/repotreex-cnb-tree/repotreex
Test Files 1 passed (1)
Tests 67 passed (67)
Start at 14:18:46
Duration 1.36s
> repotreex@0.1.0 typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.tools.json
> repotreex@0.1.0 lint
> eslint src tests scripts
Exit 0
```

Complete regression suite and proportional build/package/browser-target check:

```text
$ npx --yes -p node@24 -c 'npm test && npm run build && npm run package && esbuild src/content/search.ts --bundle --platform=browser --target=chrome120 --format=iife --log-level=info > /dev/null'
> repotreex@0.1.0 test
> vitest run
RUN v5.1.0 /Users/bytedance/.codex/worktrees/repotreex-cnb-tree/repotreex
Test Files 9 passed (9)
Tests 535 passed (535)
Start at 14:18:18
Duration 1.62s
> repotreex@0.1.0 build
> node scripts/build.mjs
dist/extension/page/bridge.js 8.1kb
dist/extension/content/index.js 29b
Done in 5ms
> repotreex@0.1.0 package
> node scripts/package.mjs
dist/extension/page/bridge.js 8.1kb
dist/extension/content/index.js 29b
Done in 7ms
Standalone Chrome 120 search bundling: no output, successful
Exit 0

$ unzip -t dist/repotreex-0.1.0.zip
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

$ git diff --check
(no output)
Exit 0

$ rg -n 'console|localStorage|sessionStorage|indexedDB|chrome\.storage|browser\.storage|cookie|fetch|setTimeout|addEventListener|removeEventListener' src/content/search.ts
101:    signal?.addEventListener("abort", onAbort, { once: true });
173:    signal?.removeEventListener("abort", onAbort);
Exit 0
```

No unhandled rejections, runtime warnings, test failures, lint errors, or
typecheck errors in GREEN. `git diff --no-index -- /dev/null` was used for full
self-review of each new source/test file; its exit 1 means differences exist,
not a validation failure. Built outputs remain ignored.

## Self-review

- All six brief steps are handled, with final commit evidence documented below.
  Search result/ranking tests catch trim, basename/path precedence, natural ties,
  literal punctuation, Unicode case, overflow, hidden cached nodes, root exclusion,
  all entry kinds, fresh result independence, and UI state preservation.
- Traversal tests catch off-by-one root/default ceilings, exact/zero/invalid
  budgets, whole-listing overflow, preloaded descendants, directory-only dispatch,
  FIFO sibling priority, peak concurrency four, duplicate/cyclic edges, numeric
  progress snapshots, drain-to-zero activity, and no extra dispatch on simultaneous
  limit/error settlement.
- Error tests preserve identity/code/status/retryAfter across all repository codes,
  unknown errors, undefined throws, and synchronous store failure. Real-store auth
  failure clears sensitive state while sibling cancellation cannot mask the auth
  error. Fatal errors after truncation are not suppressed.
- Lifecycle tests cover pre-abort, immediate abort, abort-insensitive providers,
  late success/rejection, same-context progress navigation, pending navigation,
  inactive state, progress abort/throw, listener removal, and fresh repeat calls.
- No query/path/repository data in module state, logging, storage, network calls,
  errors manufactured by search, or progress/result objects. Runtime console/storage
  spies remain silent with synthetic metadata. All traversal data is call-local;
  cleanup drops paths and sink callbacks from outstanding request continuations.
- Scoped changes only; no bootstrap/UI, bridge parsing, permissions, provider/store
  changes, or metadata persistence. No remaining blocking findings in Task 7 scope.

## Concerns and integration boundaries

1. The existing store ingests each directory listing atomically, and its interface
   has neither a bounded-ingestion argument nor a node-removal method. Consequently
   a large final listing plus already-in-flight listings can leave more than
   maxNodes cached in the shared store. Traversal reported count is capped, scheduling
   stops exactly as required, and in-flight work drains rather than being discarded.
   A hard store-memory ceiling would require a separate, explicitly approved store
   API/semantics change; this task does not silently delete cached entries.
2. `TreeStore.loadDirectory(path)` has no per-consumer AbortSignal. Cancelling a
   traversal promptly stops its own work/listener/progress, but cannot physically
   abort shared store/provider requests. Those may still populate the current
   session cache. Navigation/auth/teardown callers must use store lifecycle clearing
   plus the traversal signal to cancel store-owned work; do not clear the whole
   store just because a user cancelled filename traversal.
3. Controllers must abort on every session replacement, including same repo/ref.
   Snapshot context/root-loaded checks are additional guards, not a replacement
   for a session ID or explicit lifecycle signal if an identical session is replaced
   and fully reloaded before observation. No session-generation API was invented.
4. Callers own returned node arrays/snapshots and must release them at lifecycle
   boundaries. No physical JavaScript memory zeroization guarantee is claimed.
   `hasMoreMatches` is an array property, not preserved by map/slice or JSON array
   serialization; panel consumers should read it on the direct result.
5. Fatal failures drain outstanding requests before rejecting; use the signal to
   cancel promptly if another request never settles. Rate-limit retry timing is
   a future controller concern; no automatic timer/retry was introduced.
6. Main bootstrap is still a prior-task placeholder, so build/package alone does
   not integrate search into the UI. Direct browser-target bundling verifies the
   new module; future panel/controller tasks wire rendering and user invocation.
   No browser/manual private-repository verification claimed.
7. Existing pre-commit configuration references missing
   `script/pre_commit_checks.sh`. Checks were run directly. A normal commit is
   attempted first; only that known missing-script failure permits --no-verify.

## Commit evidence

Commit title: `feat: add bounded repository filename search`. Only search.ts,
search.test.ts, and this explicitly force-added SDD report are included. The
task-local commit-message file and generated artifacts are not staged. Resulting
commit hash is returned in the final response to avoid a self-referential hash
inside its own report. No push/merge/worktree removal is requested or performed.

```text
$ git diff --cached --check
(no output)
Exit 0

$ git status --short
A  .superpowers/sdd/2026-11-07-repotreex-cnb-tree/task-7-report.md
A  src/content/search.ts
A  tests/search.test.ts

$ git diff --cached --name-status
A .superpowers/sdd/2026-11-07-repotreex-cnb-tree/task-7-report.md
A src/content/search.ts
A tests/search.test.ts

$ git commit -F .superpowers/sdd/2026-11-07-repotreex-cnb-tree/task-7-commit-message.txt
bash: script/pre_commit_checks.sh: No such file or directory
Exit 1
```

No commit was created by the failed normal attempt. It failed only for the
confirmed missing hook script, so the authorized retry is:

```text
git commit --no-verify -F .superpowers/sdd/2026-11-07-repotreex-cnb-tree/task-7-commit-message.txt
```

The final response reports the resulting hash and completion; final git status
is checked after the retry. Branch and worktree are kept as requested. No broad
cleanup or change to hook configuration.
