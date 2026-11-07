# Task 3 Report: Typed Protocol and Read-only Request Allowlist

## Status

Implemented the typed bridge/repository protocol, explicit repository error model, and strict CNB request allowlist. All inputs and tests are synthetic; no CNB request or private data access occurred.

## Delivered

- Added `src/shared/protocol.ts` with the four permitted `BridgeOperation` variants, request/response envelopes, fixed bridge event names, and typed CNB repository DTOs without `any`.
- Added `src/shared/errors.ts` with the eight explicit `RepositoryErrorCode` values, a metadata-limited `RepositoryError`, and HTTP status classification.
- Added `src/page/allowlist.ts` to construct only the four approved same-origin CNB read endpoints from typed operations.
- Reject repository, ref, and path privilege-expansion inputs before encoding: leading/empty/dot segments, query/fragment syntax, backslashes, control characters, and the repository-only `-` route marker ambiguity.
- Clamp finite pagination values to positive integer pages and page sizes in `1..100`; reject non-finite values.
- Hardened `buildBlobUrl` so repository segments cannot contain the CNB `/-/` marker while preserving `-` as a valid ref/path segment.

## TDD Evidence

Red phase:

```text
npx --yes -p node@24 -c 'npm test -- tests/allowlist.test.ts'
FAIL: Failed to resolve import ../src/page/allowlist
```

Green and focused regression phase:

```text
npx --yes -p node@24 -c 'npm test -- tests/allowlist.test.ts tests/route.test.ts'
2 test files passed; 55 tests passed
```

## Final Validation

Executed once as the final validation chain under the required Node 24 runtime:

```text
npx --yes -p node@24 -c 'npm test -- tests/allowlist.test.ts && npm run typecheck && npm run lint && npm test'
```

Results:

- Focused allowlist suite: 1 file, 43 tests passed.
- TypeScript: application and tool/test scopes passed with no emit.
- ESLint: passed for `src`, `tests`, and `scripts`.
- Full suite: 4 files, 61 tests passed.

## Self-review

- The allowlist has no generic URL or method operation, and runtime dispatch rejects unknown operation discriminants.
- URL origin is fixed to `https://cnb.cool`; endpoints and query names are selected internally.
- User-controlled route components are validated before per-segment encoding.
- `RepositoryError` exposes only `code`, optional `status`, and optional `retryAfter`; no response body, headers, URL, repository metadata, cause, or stack-derived data is copied into its enumerable contract.
- The focused route hardening is repository-only, avoiding an unnecessary behavior change for valid `-` ref and file-path segments.

## Concerns

None for Task 3. DTO schema assumptions remain compile-time contracts and will be structurally validated at the provider boundary in Task 5 as planned.

## Fix round 1

Changed files:

- `src/page/allowlist.ts`: extended control-character rejection through the Unicode C1 range U+0080-U+009F, while retaining C0 and U+007F rejection.
- `tests/allowlist.test.ts`: added focused U+0085 and U+009F regression cases for repository, ref, and path inputs.
- `.superpowers/sdd/2026-11-07-repotreex-cnb-tree/task-3-report.md`: recorded this review fix and its validation evidence.

Covering test file: `tests/allowlist.test.ts`.

Exact validation command:

```text
npx --yes -p node@24 -c 'npm test -- tests/allowlist.test.ts && npm run typecheck && npm run lint'
```

Output:

- Focused allowlist suite: 1 file passed, 49 tests passed.
- TypeScript: application and tool/test scopes passed with no emit.
- ESLint: passed for `src`, `tests`, and `scripts`.
