# Task 6 report: in-memory tree store and secure session clearing

## Status

Implemented, self-reviewed, and validated; ready for commit with the authorized hook bypass after the normal commit failed solely for the known missing pre-commit script. Work was confined to `/Users/bytedance/.codex/worktrees/repotreex-cnb-tree/repotreex`, on branch `feature/repotreex-cnb-tree`, starting at `9c2f8d5` with a clean worktree. No subagents, push, external writes, or changes to the original workspace checkout.

## Changed files

- `src/content/tree-store.ts`: new tab-memory normalized store, exported `TreeStore`, `TreeNode`, `TreeSnapshot`, and metadata-only `TreeDirectoryError`.
- `tests/tree-store.test.ts`: 49 focused tests of public store behavior, lifecycle privacy, late provider results, subscriber reentrancy, immutability, and real provider/bridge integration.
- `.superpowers/sdd/2026-11-07-repotreex-cnb-tree/task-6-report.md`: this requested report. The SDD directory ignores reports; this report is force-added explicitly as task evidence.

Provider types are imported from `src/content/provider.ts`; `RepositoryError` is consumed from its owning shared module. Provider DTO validation, bridge protocol, permissions, preferences, panel, bootstrap, and search are unchanged.

## Behavior and interface

`createTreeStore(provider)` implements all eight required methods: `startSession`, `loadDirectory`, `toggleDirectory`, `selectPath`, `clearSensitiveData`, `subscribe`, `getSnapshot`, `dispose`.

The hidden root uses path `""`, name/initial SHA `""`, depth 0, and null parent. Visible rows use depth 1 onward and depth-first traversal of expanded directories. `loadDirectory` caches successful listings without expanding them, including empty listings; `toggleDirectory` loads on expansion and retains cached descendants on collapse. Known non-directory paths reject with `compatibility`, unknown paths with `not-found`; absent/disposed sessions reject with `cancelled`. `selectPath(null)` clears selection. Subscription callbacks take no payload and read the committed frozen snapshot via `getSnapshot`; unsubscribe is idempotent.

Private mutable Maps/Sets hold repo/ref, nodes, child arrays, expanded paths, selection, pending requests, and a numeric generation. Snapshots cache identity until a state transition, copy entries and child arrays, freeze every exposed array/record/node/error, and use own property creation so `__proto__`, `constructor`, and `toString` remain ordinary path keys. Natural stable ordering uses `Intl.Collator(undefined, { numeric: true, sensitivity: "base" })` with directories first.

Concurrent path loads share the same promise. Every dispatched provider call receives an AbortSignal. Store-owned promises cancel promptly even when a provider ignores its signal. Clearing invalidates the generation before abortion, removes private metadata/cached snapshots, detaches abort handlers, nulls pending request paths, and cancels pending work. Old success, old errors (including authorization errors), and old cleanup cannot publish, mutate, clear, or delete replacement-session requests. Generation is checked both before provider dispatch and after publication to defend against synchronous subscriber navigation.

`signed-out`/`forbidden` clear all fields and abort pending work before promise rejection handlers run, preserving the original provider rejection. Non-auth errors retain unaffected nodes and store only code/status/retryAfter; errors are retryable through `loadDirectory`, and `cancelled` is not shown as a row failure. Unknown provider exceptions reject unchanged and expose only a compatibility row error. `dispose()` fails closed, clears data, aborts, removes subscribers, and disposes the provider once, even if notification throws.

## TDD red/green evidence

Tests were written before `tree-store.ts`. Initial run:

```text
$ npx --yes -p node@24 -c 'npm test -- tests/tree-store.test.ts'
> repotreex@0.1.0 test
> vitest run tests/tree-store.test.ts
RUN v5.1.0
FAIL tests/tree-store.test.ts
Error: Failed to resolve import "../src/content/tree-store" from "tests/tree-store.test.ts". Does the file exist?
Test Files 1 failed (1)
Tests no tests
Exit 1
```

This is the missing-module red explicitly required by the brief. The first implementation executed 45 tests: 38 passed, 7 failed. Five assertions incorrectly expected Error.message in metadata-only snapshot records; they were corrected to literal code/status/retryAfter expectations, retaining exact original rejection assertions. Two failures caught the authorization-failed request's signal remaining unaborted; that signal is now aborted too. First typecheck also exposed `Promise.withResolvers` incompatibility with the existing ES2022/browser target; replaced with a standard Promise constructor without changing compiler targets.

First green:

```text
$ npx --yes -p node@24 -c 'npm test -- tests/tree-store.test.ts && npm run typecheck && npm run lint'
Test Files 1 passed (1)
Tests 45 passed (45)
> tsc --noEmit && tsc --noEmit -p tsconfig.tools.json
> eslint src tests scripts
Exit 0
```

Self-review then added two regression tests before fixing notification exception paths:

```text
$ npx --yes -p node@24 -c 'npm test -- tests/tree-store.test.ts'
Tests 2 failed | 45 passed (47)
FAIL propagates a throwing loading subscriber without leaking a request or leaving loading stuck
AssertionError: expected true to be false
FAIL preserves auth rejection when a clearing subscriber throws and still clears/cancels
AssertionError: expected Error: synthetic clearing subscriber failure to be RepositoryError: signed-out
Unhandled Rejection: RepositoryError: cancelled
Exit 1
```

Fixed the root causes: failed loading publication resets loading, settles the returned request promise rather than creating a separate rejected promise, and aborts its request; provider failures settle with the original error while synchronous cleanup completes before promise reactions. Test cleanup unsubscribes the intentionally throwing auth notification. Green then yielded 47/47 focused and 458/458 full tests without unhandled errors. Two final characterization/integration tests verify real bridge HTTP 401/403 clearing of already-normalized nodes (no new production behavior).

## Exact final validation commands and output

All npm/toolchain execution used the required Node 24 wrapper. Runtime:

```text
$ npx --yes -p node@24 -c 'node --version && npm --version'
v24.22.2
10.9.2
Exit 0
```

Required focused validation, after all final source/test edits:

```text
$ npx --yes -p node@24 -c 'npm test -- tests/tree-store.test.ts && npm run typecheck && npm run lint'
> repotreex@0.1.0 test
> vitest run tests/tree-store.test.ts
RUN v5.1.0 /Users/bytedance/.codex/worktrees/repotreex-cnb-tree/repotreex
Test Files 1 passed (1)
Tests 49 passed (49)
Start at 13:59:40
Duration 855ms
> repotreex@0.1.0 typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.tools.json
> repotreex@0.1.0 lint
> eslint src tests scripts
Exit 0
```

Proportional complete regression suite:

```text
$ npx --yes -p node@24 -c 'npm test'
> repotreex@0.1.0 test
> vitest run
RUN v5.1.0 /Users/bytedance/.codex/worktrees/repotreex-cnb-tree/repotreex
Test Files 8 passed (8)
Tests 460 passed (460)
Start at 13:59:40
Duration 1.11s
Exit 0
```

Build/package (final production source; subsequent edits only added integration tests):

```text
$ npx --yes -p node@24 -c 'npm run build && npm run package'
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
```

The main content entrypoint is still a prior-task placeholder, so build success alone does not exercise the store. Explicit browser-target store bundling:

```text
$ npx --yes -p node@24 -c 'esbuild src/content/tree-store.ts --bundle --platform=browser --target=chrome120 --format=iife --log-level=info > /dev/null'
(no output)
Exit 0
```

An initial attempt used nested `npx esbuild` inside the wrapper and npm rejected the invocation with `EUSAGE` before bundling. Corrected to the locally installed `esbuild` executable inside the same Node 24 wrapper, as shown above. No dependency or configuration changes.

```text
$ git diff --check
(no output)
Exit 0

$ rg -n 'storage|console|cookie|fetch|localStorage|sessionStorage|indexedDB|setTimeout|addEventListener' src/content/tree-store.ts
216:    controller.signal.addEventListener("abort", request.onAbort, { once: true });
```

All fixtures and assertion messages use synthetic labels. No real CNB network calls or repository metadata were logged or persisted by the implementation. Generated artifacts remain ignored.

## Self-review

- All specified methods and exports exist and compile in both production and tooling scopes without casts or compiler changes.
- Tests cover clear on 401/403, replacement for repo/ref/identical sessions, explicit clearing, teardown/dispose, abort-insensitive providers, old rejection after new success, and old finalization while the same path is loading in a new session.
- No raw provider DTO revalidation or duplicated DTO shapes; entries copied to store-owned normalized nodes. No new permissions, logs, credentials, timers, persistence, or global lifecycle listeners.
- Reentrancy tested for loading notification navigation, success notification clearing, cleared notification starting a newer session, failure notification retry, and disposal despite throwing observers. Removed pending entries before notifying terminal state so immediate retry does not deduplicate against a settled failure.
- Snapshot mutation defenses include every exposed nesting level, provider alias changes, detached error metadata, stable snapshots, and prototype-like file paths. Visible traversal is iterative, avoiding recursive stack exhaustion on deep trees.
- Retry paths preserve existing unaffected nodes and selection; cancellation never becomes a user-facing retry error. Empty directories are cached successfully. Links/submodules cannot be traversed.
- Concrete notification exception bugs were reproduced red and fixed green. No remaining blocking correctness findings in Task 6 scope.

## Concerns and integration boundaries

1. Future controller/bootstrap tasks must call `clearSensitiveData`/`dispose` on navigation, auth failure outside directory loading, pagehide, extension invalidation, and teardown. Task 6 implements the lifecycle boundary but does not prematurely implement Task 10 global event wiring. `src/content/index.ts` remains unchanged.
2. An immutable snapshot deliberately retained by a panel caller cannot be retroactively erased. The store drops all its references on clearing and publishes an empty state; callers must release old snapshots/DOM/search results at lifecycle boundaries. JavaScript offers reference release, not guaranteed physical memory zeroization.
3. Existing page-world fetch cancellation is not cross-world; a page fetch may finish after isolated-world cancellation. Store/real-provider generation and signal guards ignore it. No bridge protocol changes were made.
4. Error-code distinctions and retryAfter are preserved, but rate-limit timers/full-search throttling and refresh/new-session orchestration are future tasks. Successful directory cache is intentionally session-scoped; there is no force-refresh overload.
5. Provider exceptions propagate unchanged; stored error records are sanitized. Subscribers should not throw. The returned provider operation keeps its original rejection if notification throws during error cleanup; subscription exceptions are not persisted/logged.
6. No live browser/manual CNB verification: privacy behavior tested with deterministic synthetic deferred providers and real isolated provider/bridge event integration.
7. Configured pre-commit hook invokes missing `script/pre_commit_checks.sh`. Required checks were run directly. Only use authorized `--no-verify` if the normal commit fails for that known missing script; record the outcome below.

## Commit evidence

Commit scope checked using `git diff --cached --name-status`: only the new store, tests, and this explicitly force-added report. `git diff --cached --check` passed with no output.

```text
$ git commit -F .superpowers/sdd/2026-11-07-repotreex-cnb-tree/task-6-commit-message.txt
bash: script/pre_commit_checks.sh: No such file or directory
Exit 1
```

No commit was created by that failed attempt. Required validations ran directly, as documented above. The authorized retry command is:

```text
git commit --no-verify -F .superpowers/sdd/2026-11-07-repotreex-cnb-tree/task-6-commit-message.txt
```

Commit title: `feat: manage repository trees in tab memory`. The resulting hash is returned in the final response; this report is part of that commit, avoiding a self-referential embedded hash. The ignored task-local commit-message file is not staged.

## Fix round 1

### Status and review findings

Implemented and validated on top of `991fb77` in the existing `feature/repotreex-cnb-tree` worktree. No subagents, unrelated changes, push, or original-checkout edits.

The Important finding was reproduced: `publish()` stopped at the first exception, preventing later panel consumers from releasing sensitive snapshots and DOM on explicit clearing, authorization failure, and disposal. The Minor fixture defect was also reproduced with stronger new-state assertions: the immutability test returned the root listing for a `src` request, so the supposedly expanded node had root SHA and no matching children.

### Changed files

- `src/content/tree-store.ts`: notify all eligible listeners before propagating failures; preserve sole thrown value verbatim and aggregate multiple notification failures. Disposal performs clearing/fan-out, subscriber removal, and provider disposal before propagating or aggregating cleanup failures. Document existing provider-error precedence.
- `tests/tree-store.test.ts`: eight new regression cases (55 -> 57 includes a second self-review red/green cycle; original total 49 -> 57), plus the repaired immutability fixture and stronger assertions.
- `.superpowers/sdd/2026-11-07-repotreex-cnb-tree/task-6-report.md`: append this fix-round evidence.

### Deliberate error precedence

1. `publish()` snapshots listeners at publication start, skips listeners explicitly removed before their turn, and defers newly added listeners to the next publication. It catches only individual synchronous listener calls, collects their actual thrown values, finishes fan-out, then throws the single original value or an `AggregateError` containing all failures in subscription order. `throw undefined` remains a real failure, not a sentinel mistaken for success.
2. Direct `clearSensitiveData()` first invalidates the session, clears private data, and aborts pending work, then completes eligible subscriber fan-out before propagating notification failure. The failure collection is call-local; it is not stored, serialized, or logged.
3. Auth/provider operations preserve their original provider rejection identity. Existing failure settlement records that rejection before synchronous state cleanup/publication; Promise rejection reactions cannot run until the synchronous cleanup and full fan-out finish. Later notification failures cannot overwrite the provider error. This intentional primary-error precedence remains unchanged; no success-shaped fallback or extra unhandled rejection channel was introduced.
4. `dispose()` marks the store disposed before fan-out, clears data/aborts, removes subscribers regardless of clearing notification failure, and always attempts provider disposal. A sole cleanup failure propagates unchanged; if notification and provider disposal both fail, a disposal `AggregateError` retains both rather than the provider's exception replacing the notification failure. Repeated disposal remains a no-op.

### Covering tests and self-review

- Explicit clear/dispose with two early throwing subscribers followed by a panel consumer and a final consumer: all four run, the panel releases its held `TreeSnapshot` and clears its DOM, cancellation signal is already aborted during the final callback, and both notification failures are retained. Dispose removes subscribers and disposes the provider once even on failure; late provider success cannot restore state.
- Both signed-out and forbidden: two earlier throwing subscribers cannot prevent later consumers clearing their snapshots/DOM; the original auth `RepositoryError` remains the rejection; other pending requests cancel; late results do not publish.
- A subscriber throwing `undefined`: later consumer still notified and exact thrown value propagated.
- Unsubscribe/new-subscribe during fan-out: removed callback is excluded, later eligible callback still runs, and newly added callback runs only on the next publication.
- A non-auth network provider rejection retains original identity while later consumers receive the retryable row state despite an earlier failing subscriber.
- A simultaneous notification/provider-disposal failure retains both failures after full fan-out, removes subscribers, leaves the store cleared/disposed, and attempts provider disposal only once.
- Immutability fixture now returns the matching `source` listing for `src`. New snapshot asserts actual child paths, SHA, parent/depth, expanded/loaded status, and visible order. Old snapshot retains unloaded/unexpanded empty children, unchanged visible rows, and no newly added child key.

Self-review found the existing `finally` provider disposal could mask an earlier notification failure if both cleanup steps threw. A new regression failed before changing disposal to collect and propagate both. No remaining blocking findings in this fix scope. Provider DTO validation, bridge protocol, persistence, permissions, and bootstrap are unchanged.

### TDD red evidence

Tests and stronger Minor assertions were added before the production fix:

```text
$ npx --yes -p node@24 -c 'npm test -- tests/tree-store.test.ts'
> repotreex@0.1.0 test
> vitest run tests/tree-store.test.ts
RUN v5.1.0 /Users/bytedance/.codex/worktrees/repotreex-cnb-tree/repotreex
Tests 7 failed | 48 passed (55)
FAIL freezes every snapshot surface and copies provider entries
Expected childPaths ["src/nested", "src/index.ts"] and sha "src-sha";
received childPaths [] and sha "root-sha".
FAIL clear/dispose/auth fan-out cases
AssertionError: expected [ 'first' ] to deeply equal [ 'first', 'second', 'panel', 'last' ]
FAIL undefined failure fan-out
AssertionError: expected false to be true
FAIL unsubscribe/new-subscribe fan-out
AssertionError: expected [ 'first' ] to deeply equal [ 'first', 'last' ]
Start at 14:06:24
Duration 419ms
Exit 1
```

Corrected an initial fixture edit that matched the sorting test's similar setup line rather than the intended immutability setup; restored the sorting fixture and repaired only the immutability fixture. First green had 55 focused and 466 full tests, both typechecks and lint passing.

Added simultaneous cleanup-failure regression before changing disposal:

```text
$ npx --yes -p node@24 -c 'npm test -- tests/tree-store.test.ts'
Tests 1 failed | 56 passed (57)
FAIL retains both notification and provider disposal failures after fan-out and cleanup
AssertionError: expected Error: synthetic provider disposal failure to be an instance of AggregateError
Start at 14:07:32
Duration 414ms
Exit 1
```

### Exact final validation commands/output

```text
$ npx --yes -p node@24 -c 'npm test -- tests/tree-store.test.ts && npm run typecheck && npm run lint'
> repotreex@0.1.0 test
> vitest run tests/tree-store.test.ts
RUN v5.1.0 /Users/bytedance/.codex/worktrees/repotreex-cnb-tree/repotreex
Test Files 1 passed (1)
Tests 57 passed (57)
Start at 14:07:49
Duration 556ms
> repotreex@0.1.0 typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.tools.json
> repotreex@0.1.0 lint
> eslint src tests scripts
Exit 0

$ npx --yes -p node@24 -c 'npm test'
> repotreex@0.1.0 test
> vitest run
RUN v5.1.0 /Users/bytedance/.codex/worktrees/repotreex-cnb-tree/repotreex
Test Files 8 passed (8)
Tests 468 passed (468)
Start at 14:07:49
Duration 895ms
Exit 0

$ npx --yes -p node@24 -c 'esbuild src/content/tree-store.ts --bundle --platform=browser --target=chrome120 --format=iife --log-level=info > /dev/null'
(no output)
Exit 0

$ git diff --check
(no output)
Exit 0
```

No unhandled errors/rejections in green. Full suite includes packaging reproducibility; standalone browser-target bundling covers the store while bootstrap remains a placeholder.

### Concerns and commit

No blocking concerns. Callers still must release retained immutable snapshots/DOM when notified; notifications cannot force a deliberately misbehaving consumer to erase its own references. Primary provider rejection precedence is intentional; synchronous explicit clear/dispose callers receive notification/cleanup failures only after required work completes. All fixtures are synthetic and no metadata logging/persistence was added.

Commit title: `fix: complete secure tree-store notification fan-out`. Only the store, tests, and report are staged. Known missing pre-commit script workaround remains authorized; commit evidence follows.

```text
$ git diff --cached --check
(no output)
Exit 0

$ git commit -F .superpowers/sdd/2026-11-07-repotreex-cnb-tree/task-6-fix-round-1-commit-message.txt
bash: script/pre_commit_checks.sh: No such file or directory
Exit 1
```

Normal commit failed only for the confirmed missing script. Retrying with the authorized workaround:

```text
git commit --no-verify -F .superpowers/sdd/2026-11-07-repotreex-cnb-tree/task-6-fix-round-1-commit-message.txt
```

SDD report staging requires `git add -f` because the enclosing directory is ignored; only the named report is included. Commit hash is returned in the final response. No commit-message file or generated artifact is staged.
