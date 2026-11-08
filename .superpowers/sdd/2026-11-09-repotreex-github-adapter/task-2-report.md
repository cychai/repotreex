# Task 2 Report: Extract the CNB Adapter Without Behavior Change

## Status

Complete. CNB route parsing/building/reconciliation, provider DTO validation/request orchestration,
layout contract scaffolding, and the composed adapter now live under `src/platforms/cnb/`. Legacy
route and provider exports remain available for the staged migration. Existing panel DOM ownership
and bridge operation shapes are unchanged.

## RED Evidence

Command:

```text
npx vitest run tests/route.test.ts tests/provider.test.ts
```

Exit code: `1`.

Relevant output:

```text
FAIL  tests/provider.test.ts [ tests/provider.test.ts ]
Error: Failed to resolve import "../src/platforms/cnb/provider" from "tests/provider.test.ts".

FAIL  tests/route.test.ts [ tests/route.test.ts ]
Error: Failed to resolve import "../src/platforms/cnb/route" from "tests/route.test.ts".

Test Files  2 failed (2)
Tests       no tests
```

The failure was expected: the adapter-boundary tests imported the required CNB modules before those
modules existed.

## GREEN Evidence

Focused command after implementation:

```text
npx vitest run tests/route.test.ts tests/provider.test.ts
```

Exit code: `0`.

```text
Test Files  2 passed (2)
Tests       281 passed (281)
Duration    715ms
```

Final required regression command:

```text
npm test && npm run typecheck && npm run lint
```

Exit code: `0`.

```text
> repotreex@0.1.0 test
> vitest run

Test Files  16 passed (16)
Tests       876 passed (876)
Duration    8.57s

> repotreex@0.1.0 typecheck
> tsc --noEmit && tsc --noEmit -p tsconfig.tools.json

> repotreex@0.1.0 lint
> eslint src tests scripts
```

TypeScript and ESLint completed with no diagnostics.

## Files Changed

- `src/platforms/cnb/route.ts`: owns normalized CNB route parsing, longest-ref reconciliation,
  canonical file URL building, and canonical ref-root URL building.
- `src/platforms/cnb/provider.ts`: owns the existing CNB provider implementation, including bounded
  arrays, descriptor-only hostile-payload inspection, pagination, deduplication, cancellation, and
  disposal behavior.
- `src/platforms/cnb/layout.ts`: adds the contract-compatible CNB layout scaffold; panel DOM behavior
  remains in `src/content/panel.ts` per the binding ruling.
- `src/platforms/cnb/index.ts`: composes `cnbAdapter` with the exact `https://cnb.cool` origin and
  re-exports CNB adapter surfaces.
- `src/shared/route.ts`: retains the legacy `kind/repo/filePath` compatibility facade while
  delegating to the normalized CNB route implementation; also re-exports the new route builders and
  reconciler.
- `src/content/provider.ts`: retains normalized provider types and exports deprecated
  `createSessionProvider` as an alias of `createCnbProvider`.
- `tests/route.test.ts`: targets the CNB route adapter boundary, verifies normalized platform identity,
  longest discovered ref selection, canonical encoded file/root URLs, and adapter composition.
- `tests/provider.test.ts`: targets `createCnbProvider` while preserving every existing provider,
  hostile-payload, pagination, abort, disposal, and live-schema assertion.

## Self-Review

- Compared `src/platforms/cnb/provider.ts` against the prior provider source after accounting only for
  relative import paths and the exported factory name; the diff was empty.
- Confirmed the normalized route fields are `platform/view/repository/ref/path`, with unsupported
  routes retaining the existing frozen `{ kind: "unsupported" }` shape.
- Confirmed longest-ref reconciliation sorts candidates descending by length and accepts only a
  matching blob route.
- Confirmed canonical slash refs remain encoded as one URL segment (`release%2Fv1`) and file paths
  remain segment-encoded.
- Confirmed the exact CNB origin is present in `cnbAdapter` and cross-platform routes are rejected by
  CNB URL builders.
- Confirmed legacy controller, bootstrap, and tree-store imports remain green through compatibility
  exports; no mandatory platform-qualified bridge protocol was introduced.
- Confirmed `content/panel.ts` was not modified and `cnbLayout` is intentionally a no-op scaffold.
- `git diff --check` completed with no whitespace errors before the final verification run.

## Concerns

- `cnbLayout` intentionally does not own DOM layout yet; Task 9 must replace the scaffold when panel
  layout ownership moves.
- The legacy route facade reconstructs commit identity from the URL because the normalized contract
  represents commit pages as repository-root views. This preserves current controller behavior while
  the controller remains on legacy route types.
- Legacy `createSessionProvider` and legacy route field names remain intentionally in use outside the
  adapter tests until the later migration tasks remove them.
