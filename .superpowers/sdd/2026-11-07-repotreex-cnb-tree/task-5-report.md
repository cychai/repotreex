# Task 5 Report: Repository Provider and Strict CNB Response Validation

## Status

Implemented Task 5 in `/Users/bytedance/.codex/worktrees/repotreex-cnb-tree/repotreex` on `feature/repotreex-cnb-tree`, starting from `b6182c5`. The initial worktree was clean. Git reports distinct worktree/common Git directories and no superproject, confirming an existing linked worktree. No subagents, live CNB requests, signed-in sessions, or real repository metadata were used.

The complete requirements were read from `task-5-brief.md` before implementation. Used the test-driven-development and its writing-good-tests guidance for test-first implementation, executing-plans guidance for the supplied task, verification-before-completion for direct validation, and git-commit guidance for scoped commit evidence. Existing isolation was retained; the explicit request to commit this task takes precedence over offering unrelated merge/push choices. No new worktree, OAuth implementation, protocol change, controller/store implementation, logging, or persistent repository storage was added.

## Changed files

- `src/content/provider.ts`: exact exported `EntryKind`, `RepositoryEntry`, `DirectoryListing`, `RefOption`, `RepositoryProvider`, and `createSessionProvider(client)` contracts; unknown-data boundary; explicit DTO guards; normalization; branch/tag pagination; cancellation and idempotent disposal.
- `tests/provider.test.ts`: 202 synthetic cases covering normalization, all DTO fields, malformed success data, pagination, exact operation/signal forwarding, errors, cancellation races, late responses, disposal, copying, and no cross-call ref cache.
- `tests/fixtures/repository.ts`: typed synthetic head/tree/blob fixtures, all four entry types, root directory, and 100-item reference page generator.
- `.superpowers/sdd/2026-11-07-repotreex-cnb-tree/task-5-report.md`: this report, force-added because `.superpowers/sdd/.gitignore` ignores reports by default, following the existing Task 3/4 delivery convention.

Existing bridge client, DTO/error contracts, allowlist, manifest, build scripts, package metadata, and content bootstrap are unchanged. Build artifacts remain ignored.

## TDD red/green evidence

### Initial red: missing provider

Wrote all original 194 provider cases and synthetic fixtures before production implementation. Ran exactly the brief's focused command with the requested Node 24 wrapper:

```text
npx --yes -p node@24 -c 'npm test -- tests/provider.test.ts'

> repotreex@0.1.0 test
> vitest run tests/provider.test.ts
RUN v5.1.0
FAIL tests/provider.test.ts
Error: Failed to resolve import "../src/content/provider" from "tests/provider.test.ts". Does the file exist?
Test Files  1 failed (1)
Tests       no tests
Duration    513ms
Exit 1
```

This is the missing-file red required by the brief, not an assertion-only failure. Then implemented the provider using existing BridgeClient/DTO/error contracts.

### First green attempt and lint correction

```text
npx --yes -p node@24 -c 'npm test -- tests/provider.test.ts && npm run typecheck && npm run lint'

Test Files  1 passed (1)
Tests       194 passed (194)
Duration    513ms
tsc --noEmit && tsc --noEmit -p tsconfig.tools.json: no diagnostics
eslint src tests scripts:
tests/provider.test.ts:82:19
error Do not delete dynamically computed property keys @typescript-eslint/no-dynamic-delete
1 problem (1 error, 0 warnings)
Exit 1
```

Replaced dynamic deletion in the missing-field test with a filtered record. Removed an unnecessary test-side error cast using an `instanceof RepositoryError` guard. No production lint bypass was added.

### Self-review red: cancellation/disposal microtask race

Self-review found that a shared async request wrapper introduces an additional promise continuation. Checking activity inside that wrapper alone can allow abort/disposal to occur before the public method's normalization continuation, yet still publish success. Added eight tests first, scheduling abort/disposal with `queueMicrotask` across all four public read methods.

```text
npx --yes -p node@24 -c 'npm test -- tests/provider.test.ts'

tests/provider.test.ts (202 tests | 8 failed)
rejects head/directory/branches/tags if abort lands between request settlement and normalization
rejects head/directory/branches/tags if disposal lands between request settlement and normalization
AssertionError: promise resolved ... instead of rejecting
Test Files  1 failed (1)
Tests       8 failed | 194 passed (202)
Duration    462ms
Exit 1
```

Moved the post-await activity check into each public method's normalization continuation and the pagination loop. The before-request check remains in the shared wrapper. This fixes the cause without adding cancellation listeners, a second cancellation protocol, or suppressing client errors.

## Final validation: exact commands and outputs

```text
npx --yes -p node@24 -c 'node --version && npm test -- tests/provider.test.ts && npm run typecheck && npm run lint && npm test && npm run build && npm run package'

v24.22.2

> repotreex@0.1.0 test
> vitest run tests/provider.test.ts
RUN v5.1.0
Test Files  1 passed (1)
Tests       202 passed (202)
Duration    394ms

> repotreex@0.1.0 typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.tools.json
(no diagnostics)

> repotreex@0.1.0 lint
> eslint src tests scripts
(no diagnostics)

> repotreex@0.1.0 test
> vitest run
RUN v5.1.0
Test Files  7 passed (7)
Tests       346 passed (346)
Duration    771ms

> repotreex@0.1.0 build
> node scripts/build.mjs
dist/extension/page/bridge.js    8.1kb
dist/extension/content/index.js 29b
Done in 4ms

> repotreex@0.1.0 package
> node scripts/package.mjs
dist/extension/page/bridge.js    8.1kb
dist/extension/content/index.js 29b
Done in 7ms
Exit 0
```

The full suite includes real packaging reproducibility across UTC and Asia/Shanghai, as well as all existing route, allowlist, manifest, page-bridge, and typed-client regressions.

```text
unzip -t dist/repotreex-0.1.0.zip

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

git diff --check
(no diagnostics)
Exit 0
```

Read the complete new source, tests, and fixture files in self-review. The privacy/static inspection command was:

```text
rg -n 'console|storage|localStorage|sessionStorage|indexedDB|fetch|cookie|OAuth|as any|as unknown' src/content/provider.ts tests/provider.test.ts tests/fixtures/repository.ts
(no matches)
```

This inspection supplements the runtime tests and source review; it is not represented as a runtime privacy proof. No real repository data was printed in any command or report.

## Self-review

- Structural validation is load-bearing: `client.request<unknown>` is used rather than trusting its generic return assertion. Guards reject nulls, primitives, arrays-as-records, inherited-only required fields, missing/undefined/wrong-type fields, empty entry names/paths/hashes and ref names/hashes, malformed collections, sparse array slots, and unsupported entry types. Sparse slots are visited by `for...of` instead of skipped by `Array.every`.
- Every declared TreeContent field is checked, including required `size`. Optional TreeEntry `size` is checked when present, must be owned, and must be finite/nonnegative. Root path/name may be empty strings as the DTO requires; no missing value is coerced to an empty string. Tree content with any type other than `tree` is rejected, including a fully valid BlobContent.
- Type mapping is exhaustive and typed: tree to directory, blob to file, link/submodule preserved. Returned objects contain only the specified normalized fields and are newly allocated. Extra CNB fields are allowed for forward compatibility but never included in the provider result. Input fixtures can be frozen and are not mutated.
- Both reference endpoints begin at page 1, request pageSize 100, and continue on raw pages of exactly 100 until a short page, including an empty terminal page. Pages over 100 are rejected as contract violations. All records are validated before deduplication, so malformed duplicate records cannot bypass guards. No partial data is returned after an invalid page or client failure.
- Deduplication uses a request-local Map keyed by exact name; first occurrence wins on conflicting hashes. Sorting is deterministic UTF-16 string ordering, independent of runtime locale. Slash/case/whitespace/Unicode names remain exact and names such as `__proto__` are safe Map keys. No ref cache, module-level repository data, or logging/persistence mechanism exists.
- getHead validates both name and sha and returns name, the usable ref rather than a commit hash. Bridge requests remain the existing fixed operations; no arbitrary fetch or OAuth surface was introduced.
- Optional AbortSignal is forwarded for every request and page. Pre-aborted/disposed requests never dispatch. Checks at public post-await boundaries prevent stale success publication for the demonstrated races. Real typed-client integration tests exercise in-flight cancellation, ignored late responses, and pending-request disposal. No extra cross-world cancel message exists.
- RepositoryError from the client is propagated unchanged, preserving code/status/retryAfter. Provider validation errors contain only compatibility code/message and never attach DTOs, repo/ref/path, request URL, body, cause, or abort reason. Cancellation errors are similarly metadata-limited. There are no production catch-all handlers or success-shaped fallbacks.
- dispose is idempotent, prevents provider reuse, and delegates disposal to the supplied client once. The provider owns that client lifetime; callers must not share it with independently disposed providers.
- Mentally checked realistic mutations: wrong entry-kind mapping, unchecked tree/entry/ref fields, skipped sparse slots, trusting typed bridge data, pageSize/start-page changes, stopping at deduplicated count, skipping malformed duplicates, hash-based deduplication, lost signal, swallowed page errors, missing post-await activity checks, client reuse after disposal, and forwarding extra DTO data all have relevant tests.
- Reviewed Task 5 requirements item by item. Tests, implementation, static checks, full validation, self-review, and requested report are complete. Commit is the final handoff step; no optional pending implementation work is included in the scope.

## Concerns and boundaries

- Live authenticated CNB responses and Chrome/QQ Browser isolated/main-world operation are not verified; fixtures use the existing declared DTO contracts only. No live metadata may be logged to investigate drift. Browser acceptance remains a later task.
- Guards enforce declared structure, not Git hash syntax, path ancestry/name consistency, path-to-request equality, or unmentioned schema formats. Nonempty synthetic hashes are intentionally valid. Number sizes are finite/nonnegative as declared, without imposing an undocumented integer encoding rule. Unknown extra CNB fields are discarded, not rejected.
- Reference pagination intentionally has no arbitrary page-count cap, per the requirement to continue until a short page. A server returning full pages forever will require caller cancellation; no cache or persistent state is accumulated beyond that request's local result Map.
- Abort/disposal cancel observation through BridgeClient, not main-world fetch execution. Later store/controller sessions must still ignore results that settled before cancellation or belong to an older navigation session.
- Content bootstrap remains a stub for the later controller task, so current extension build output does not yet import/bundle the provider. Source tests and both TypeScript scopes validate the consumable module; build/package checks ensure no regressions, not mounted UI acceptance.
- The configured hook `/Users/bytedance/.bytesec/commit_hook/pre-commit` delegates to missing `script/pre_commit_checks.sh`. Direct required checks passed. The user explicitly permits `git commit --no-verify` if necessary; no hook/config change is within this task.

## Commit handoff

The exact requested title is `feat: add typed CNB repository provider`, with a body describing the validated DTO boundary, reference pagination, memory-only/cancellation behavior, and Node 24 evidence. Only the three requested source/test files and this requested report are included. Commit hash is returned by Git rather than embedded self-referentially in this report. Branch/worktree will be preserved without merging, pushing, or creating a PR.

The initial normal commit attempt confirmed the hook blocker:

```text
git status --short
A  .superpowers/sdd/2026-11-07-repotreex-cnb-tree/task-5-report.md
A  src/content/provider.ts
A  tests/fixtures/repository.ts
A  tests/provider.test.ts

git diff --cached --name-status
A .superpowers/sdd/2026-11-07-repotreex-cnb-tree/task-5-report.md
A src/content/provider.ts
A tests/fixtures/repository.ts
A tests/provider.test.ts

git commit -F .superpowers/sdd/2026-11-07-repotreex-cnb-tree/task-5-commit-message.txt
bash: script/pre_commit_checks.sh: No such file or directory
Exit 1
```

All direct validations passed and the normal hook attempt failed for the known missing script, so the same reviewed scope/message is retried with the expressly authorized `git commit --no-verify -F .superpowers/sdd/2026-11-07-repotreex-cnb-tree/task-5-commit-message.txt`. No hook configuration is modified. The ignored task-local message file is temporary and is removed after the commit; it is not included in the commit.
