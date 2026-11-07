# RepoTreeX manual verification matrix

Run this matrix against `dist/extension/` after all automated checks pass. Use
only repositories and accounts the tester is authorized to access.

## Evidence safety

Use synthetic labels in notes: `PUBLIC_REPO`, `PRIVATE_REPO`, `BRANCH_A`,
`TAG_A`, `DIR_A`, and `FILE_A`. Do not copy real private repository names,
refs, paths, file names, response bodies, account identifiers, or access tokens
into reports. Screenshots and logs containing private paths are prohibited.
If a private-repository check needs evidence, record only the matrix case ID,
browser/version, pass/fail, and sanitized fixed error category. Inspect DevTools
locally when needed, then close it without exporting private traffic or logs.

## Preconditions

- Use a clean browser profile or document the existing extension state.
- Run `npm ci`, `npm test`, `npm run typecheck`, `npm run lint`, and
  `npm run package` with Node 24.
- Prepare an authorized public repository and, only with explicit permission,
  an authorized private repository. Include a nested directory, a branch and
  tag, and a branch or tag containing `/`. Refer to all of them by synthetic
  labels in results.
- Prepare network controls capable of simulating offline, `5xx`, `401`, `403`,
  `404`, and `429` without recording private request details.

## Installation and routes

| ID | Check | Procedure | Pass condition |
|---|---|---|---|
| I-01 | Install | Enable developer mode and load `dist/extension/` in QQ Browser, then repeat in Chrome. | No install error; manifest shows only storage and `https://cnb.cool/*` access. |
| I-02 | Extension reload | Open `PUBLIC_REPO`, reload RepoTreeX from extension management, then reload the tab. | One panel appears; repository data reloads without duplicate panels. |
| I-03 | Public repository | Open the root of `PUBLIC_REPO`. | Panel appears and root entries load. |
| I-04 | Private repository | While signed in with authorized access, open `PRIVATE_REPO` without capturing screen or logs. | Panel loads authorized content; no token/cookie prompt appears. |
| I-05 | Root file | Open root-level `FILE_A` from CNB and from the tree. | Canonical blob route opens and the matching row is selected. |
| I-06 | Nested file | Open `DIR_A/.../FILE_A` directly. | Ancestors expand lazily, selection is revealed, and the row is visible. |
| I-07 | Repository root | Navigate from a file to repository root. | Tree stays synchronized and resolves the repository HEAD. |
| I-08 | Commit route | Open a single-commit route for `PUBLIC_REPO`. | RepoTreeX resolves HEAD and renders one panel without altering the commit page route. |
| I-09 | Unsupported route | Navigate to a non-repository CNB page. | Panel unmounts and CNB layout is restored. |

## Tree, refs, and search

| ID | Check | Procedure | Pass condition |
|---|---|---|---|
| T-01 | Folder expansion | Expand, collapse, and reopen `DIR_A`. | Children load once, collapse hides them, and reopening uses the tab-memory cache. |
| T-02 | Current-file reveal | Navigate between two files through CNB controls. | Existing tree remains and selection/reveal follows the URL. |
| T-03 | Branch change | Select `BRANCH_A`, then switch back. | URL and tree replace with the selected branch; outgoing selection/data do not flash. |
| T-04 | Tag change | Select `TAG_A`. | URL and tree replace with the tag and current path is retained only when valid. |
| T-05 | Slash-containing ref | Open and select a discovered ref such as synthetic `release/v1`. | Longest discovered ref boundary is used and file path remains correct. |
| T-06 | Loaded-node search | Load several folders and search by a synthetic filename/path fragment. | Matching loaded nodes appear case-insensitively; clearing restores the tree. |
| T-07 | Full-tree search | Start **Load full tree for search** on a bounded fixture. | Progress is visible, UI remains usable, and newly loaded names become searchable. |
| T-08 | Full-tree cancel | Start loading and choose cancel before completion. | Scheduling stops, cancellation is not shown as an error, and loaded data remains usable. |
| T-09 | Full-tree truncation | Use a synthetic fixture exceeding 10,000 non-root nodes. | Loading stops at the bound and explicitly reports truncation. |
| T-10 | Refresh | Use the panel refresh control. | Current repo/ref tree reloads and stale selection/error state is cleared. |

## Layout, lifecycle, and navigation

| ID | Check | Procedure | Pass condition |
|---|---|---|---|
| L-01 | Resize persistence | Resize by pointer and keyboard, reload the page, and reopen the same and another CNB tab. | Width remains within 240-560 px and the last persisted width is restored. |
| L-02 | Collapse persistence | Collapse, reload, reopen, and expand; inspect RepoTreeX extension storage locally. | Open/closed state persists; the sole `repotreex.preferences` record contains exactly `panelOpen` and `panelWidth`, with no repository metadata. |
| L-03 | SPA navigation | Navigate root -> file -> another file without full page loads. | Exactly one panel remains; file-only navigation reuses the current tree. |
| L-04 | Back/forward | Use browser Back and Forward across supported and unsupported CNB routes. | Selection/session follow history; unsupported routes remove the panel and returning remounts it once. |
| L-05 | Page reload | Reload a supported file route. | Preferences restore and repository data is fetched fresh rather than restored from storage. |
| L-06 | Extension reload | Reload the extension while a repository tab is open, then reload the tab. | Old UI/data disappear; one fresh panel mounts after tab reload. |
| L-07 | Removal | Record CNB layout, remove RepoTreeX from extension management, and reload CNB. | Panel is absent and CNB padding/layout return to the pre-extension state. |

## Accessibility and browser coverage

| ID | Check | Procedure | Pass condition |
|---|---|---|---|
| A-01 | Light mode | Use CNB light appearance at desktop and narrow viewport widths. | Text, focus, selection, controls, and errors remain legible; no clipping blocks CNB content. |
| A-02 | Dark mode | Repeat A-01 in dark appearance. | Contrast and focus remain visible without relying on color alone. |
| A-03 | Tree keyboard | Focus the tree; use Up/Down, Home/End, Left/Right, Enter, and Space. | Roving focus is visible; arrows move/collapse/expand as appropriate; Enter/Space opens or toggles. |
| A-04 | Control names | Inspect search, refresh, ref selector, collapse/reopen, resize, retry, load, and cancel with accessibility tools. | Every control has a meaningful accessible name and tree rows expose tree/treeitem state. |
| A-05 | Reduced motion | Enable reduced motion and exercise resize/collapse/reveal. | No non-essential animated transition remains. |
| A-06 | Browser parity | Repeat I-01, I-03, I-05, T-01, T-03, T-06, L-01, A-01, and A-03 in current QQ Browser and Chrome. | Core behavior and accessibility are equivalent; differences are recorded without private metadata. |

## Errors and access lifecycle

| ID | Check | Procedure | Pass condition |
|---|---|---|---|
| E-01 | Offline | Go offline before root load and before expanding `DIR_A`; restore network and retry. | Fixed network error appears; retry succeeds; no empty-success tree is shown. |
| E-02 | `5xx` | Inject a synthetic `503` for root and directory loads, then remove it and retry. | Server error is distinguishable and retryable; unaffected loaded nodes remain. |
| E-03 | `401` | In a synthetic/public-safe setup, force a `401`. | Repository DOM and in-memory tree clear immediately and a sign-in message appears. |
| E-04 | `403` | Revoke/simulate denied access without recording private data. | Repository DOM and memory clear immediately and an access-denied message appears. |
| E-05 | `404` | Request a removed synthetic path/ref and retry after restoration. | Inline not-found state does not erase unrelated nodes; valid retry or documented ref-root fallback occurs. |
| E-06 | `429` | Inject rate limiting during folder and full-tree loading, with `Retry-After` when available. | Rate-limit state is distinct; ordinary full-tree starts remain disabled until explicit retry/refresh. |
| E-07 | Logout | With authorization, sign out in CNB while `PRIVATE_REPO` is open, then trigger another request. | Next failed authorization clears repository UI/memory; no private screenshot/log is retained. |
| E-08 | Recovery isolation | Cause an error in `DIR_A`, then load/retry another directory. | Unrelated success does not erase `DIR_A`'s error; matching retry clears only its owner. |

Record pass/fail by ID using synthetic labels only. A failed live check is a
release concern; do not replace it with an automated-test result or infer
private-repository correctness from public fixtures.
