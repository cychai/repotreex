# RepoTreeX CNB Repository Tree Design

## 1. Purpose

RepoTreeX is a Manifest V3 browser extension for `https://cnb.cool/`. It adds an
Octotree-like repository explorer to CNB repository pages without copying or
depending on Octotree source code.

The first release must support repositories visible to the user who is already
signed in to CNB, including private repositories. Its core workflow is:

1. Open a CNB repository or file page.
2. See a left-side repository tree for the current branch or tag.
3. Expand directories and jump to files without returning to the repository
   root.
4. Search file names, locate the current file, and keep the tree synchronized
   with CNB navigation.

The first release does not include full-text code search, multiple file tabs,
bookmarks, file history, or merge-request change trees.

## 2. Clean-room Boundary

RepoTreeX implements observed product behavior and CNB's documented/public web
interfaces independently. It must not include decompiled, copied, transformed,
or derived Octotree source code, assets, product identifiers, or proprietary
protocols.

Octotree is a user-experience reference only. CNB documentation, CNB's OpenAPI
schema, and observed CNB URLs/responses are the technical sources of truth.

## 3. Authentication Strategy

### 3.1 Primary: current CNB web session

The extension reuses the current `cnb.cool` tab's authenticated web session.
A small bridge that runs in the page's main JavaScript world sends same-origin
read-only requests with `credentials: "include"`. The browser attaches CNB's
HttpOnly cookies automatically.

The extension must never:

- call the browser cookies API;
- read or serialize `document.cookie`;
- export, log, persist, or transmit CNB cookies;
- ask the user to copy a personal access token;
- make mutation requests to CNB.

This keeps private-repository access identical to the current CNB page. If the
user signs out or loses access, subsequent requests fail and RepoTreeX removes
the repository data from memory.

### 3.2 Secondary: CNB OAuth 2.0

OAuth is a fallback for environments where CNB no longer permits web-session
requests from the page bridge. It is not required to operate the first build.

The extension will reserve an authentication provider interface and document
the application-registration requirements. OAuth must use a public-client flow
appropriate for an installed extension: Authorization Code with PKCE and no
embedded client secret, or CNB's Device Authorization Grant. The requested
permissions are read-only and minimal:

- `repo-code:r` for repository contents and branches;
- `repo-release:r` only when tag enumeration is enabled.

No placeholder or invented `client_id` will ship. OAuth controls remain hidden
until a real CNB application is approved and configured.

## 4. CNB Integration

### 4.1 Read-only endpoints

The primary provider uses CNB's same-origin web endpoints:

```text
GET /{repo}/-/git/contents?ref={ref}
GET /{repo}/-/git/contents/{path}?ref={ref}
GET /{repo}/-/git/head
GET /{repo}/-/git/branches?page={page}&page_size={size}
GET /{repo}/-/git/tags?page={page}&page_size={size}
```

Directory responses contain `tree`, `blob`, `link`, and `submodule` entries.
RepoTreeX normalizes those into one internal node model. The request layer
allows only `GET`, same-origin `https://cnb.cool` URLs, and the explicit path
templates above. Query parameters are constructed by RepoTreeX, not accepted
as arbitrary page messages.

### 4.2 URL and route model

CNB repositories can contain multiple group path segments, so the repository
slug cannot be parsed as a fixed `owner/repo` pair. RepoTreeX identifies the
repository boundary using CNB route markers such as `/-/blob`, `/-/commit`,
`/-/branches`, and `/-/pulls`, plus repository-page metadata when present.

The route parser returns:

- repository slug;
- current ref, when present;
- current file path, when present;
- page kind: repository, blob, commit, or unsupported;
- a canonical URL builder for a file/ref pair.

Unknown route shapes do not trigger requests. They produce a non-invasive
hidden state and a diagnostic message only in development builds.

### 4.3 Single-page navigation

CNB uses client-side navigation. The content script observes URL changes via
`popstate`, `hashchange`, and a lightweight history bridge. It re-parses the
route after navigation without creating duplicate sidebars.

Repository or ref changes create a new in-memory session and discard the old
tree. File-only changes retain the tree and update selection. Clicking a tree
file navigates to the canonical CNB blob URL so browser history, sharing, and
CNB's own code viewer continue to work.

## 5. Extension Architecture

### 5.1 Build and package

The project uses TypeScript with a small build pipeline that emits a loadable
Manifest V3 extension. The runtime UI uses native DOM APIs and an isolated
Shadow DOM. A framework is unnecessary for the first release because the UI
is a single tree panel and avoiding a runtime framework reduces privileges,
bundle size, and integration surface.

The produced extension contains:

- `manifest.json`;
- isolated-world content script and styles;
- main-world session bridge;
- options/popup surface only if OAuth configuration later requires it;
- static icons and license notices.

### 5.2 Components

#### Route controller

Parses CNB URLs, detects SPA navigation, and owns the active repository/ref/file
context. It is the only component allowed to initiate session replacement.

#### Session bridge

Runs in the page main world. It receives typed request messages, validates the
operation against a fixed allowlist, performs same-origin credentialed fetches,
and returns structured success/error responses. Messages include a per-install
channel identifier and request identifier; responses are accepted only from
the current window and matching channel.

#### Repository provider

Offers typed methods such as `listDirectory`, `listBranches`, `listTags`, and
`getHead`. The initial implementation uses the session bridge. A future OAuth
provider can implement the same interface without changing tree behavior.

#### Tree store

Normalizes entries, sorts directories before files, tracks loading/error state,
and indexes loaded nodes by full path. The store exists only in the content
script memory for the current tab.

#### Tree panel

Renders a resizable left rail in Shadow DOM. It includes a compact header,
repository/ref label, search field, refresh action, directory rows, file rows,
loading/error states, and a collapse handle. It uses CNB-compatible neutral
colors while retaining independent RepoTreeX branding and selectors.

#### Search controller

Filters the loaded node index by case-insensitive file or path substring. A
user-invoked "load full tree" action performs bounded breadth-first traversal
for repository-wide filename search. It limits concurrency and total nodes,
supports cancellation, and reports truncation instead of silently omitting
results.

#### Preference store

Persists only non-sensitive UI preferences in `chrome.storage.local`:

- panel open/closed state;
- panel width;
- compact display preference, if added.

It must not store repository slugs, refs, file paths, tree nodes, expanded
paths, search queries, or private-repository metadata.

## 6. Data Flow

Initial repository load:

1. The route controller identifies a supported CNB repository page.
2. The tree panel mounts once and restores non-sensitive UI preferences.
3. The provider requests HEAD/ref information and the root directory.
4. The session bridge validates and sends same-origin credentialed requests.
5. The tree store normalizes the response and the panel renders root entries.
6. If the URL identifies a file, its loaded ancestors expand lazily and the
   file row is selected and scrolled into view.

Directory expansion:

1. The panel asks the store for a directory.
2. If it is not loaded, the provider requests that exact path and ref.
3. The store records success or an explicit error state.
4. Collapsing a directory keeps its children in tab memory for fast reopening.

Ref changes:

1. A CNB page navigation or RepoTreeX selector changes the canonical URL.
2. The route controller discards the old session before loading the new ref.
3. Pending requests are aborted and late responses are ignored by session ID.

## 7. Security and Privacy

The implementation follows least privilege:

- host access is limited to `https://cnb.cool/*`;
- no `cookies`, `webRequest`, browsing-history, clipboard, or broad tab
  permissions;
- only read-only repository paths are callable;
- all repository data remains in tab memory;
- user-facing errors omit response bodies that might contain sensitive data;
- production logging contains no repo, ref, path, response, cookie, or token;
- OAuth tokens, if later enabled, use extension-local storage and are never
  exposed to page scripts.

On `401` or `403`, RepoTreeX aborts pending requests, clears the tree and search
index, and presents a signed-out/access-denied state. On repository/ref changes,
tab close, extension reload, or content-script teardown, the old in-memory
session becomes unreachable.

The extension cannot guarantee that CNB invalidates every already-completed
response at the exact instant of logout. It guarantees that no repository data
is persisted and that the next failed authorization check clears the current
in-memory state.

## 8. Error Handling

Errors remain distinguishable:

- `401`: CNB login expired; clear data and ask the user to sign in.
- `403`: access denied; clear data and explain that repository permission is
  insufficient.
- `404`: repository/ref/path no longer exists; retain unaffected tree state and
  show an inline retryable row error.
- `429`: rate limited; pause full-tree traversal and offer retry after the
  server-provided delay when available.
- `5xx` or network failure: retain already loaded nodes, display a retry action,
  and do not present stale data as freshly loaded.
- malformed response: reject it explicitly and expose a compatibility error.

No broad catch converts errors into empty successful trees. Aborts caused by
navigation are normal cancellation and are not shown as failures.

## 9. User Experience

The default panel is approximately 300 pixels wide, resizable within safe
minimum and maximum bounds, and collapsible to a narrow reopen control. The
content area is adjusted without permanently modifying CNB markup. RepoTreeX
restores the page layout fully when disabled or unmounted.

Keyboard and accessibility requirements:

- semantic tree/treeitem roles and current selection;
- arrow-key navigation through visible rows;
- Enter opens a file or toggles a directory;
- focus remains visible in light and dark CNB themes;
- controls have accessible names and do not rely on color alone;
- animations respect `prefers-reduced-motion`.

File and folder icons are original, simple SVGs or permissively licensed assets.
The interface must not use Octotree names, logos, or copied visual assets.

## 10. Performance Limits

Directory loading is lazy by default. Requests for the same repo/ref/path are
deduplicated in memory. Full-tree search uses a small fixed concurrency limit
and stops at a documented node ceiling. The UI remains usable while traversal
runs and exposes progress and cancellation.

Large result lists use incremental rendering or simple windowing when the
visible-node count crosses a threshold. Rendering and route synchronization are
debounced to one animation frame where appropriate.

## 11. Verification

### Automated tests

- URL parsing for nested groups, root pages, blob pages, encoded refs/paths,
  unsupported routes, and malformed URLs;
- canonical file URL construction;
- bridge allowlist rejection of arbitrary hosts, methods, paths, and queries;
- tree normalization, ordering, deduplication, expansion, and selection;
- search matching, traversal cancellation, concurrency, and node limits;
- session replacement and rejection of late responses;
- `401`/`403` memory clearing;
- preference allowlist proving repository metadata is not persisted.

### Browser integration checks

- load the unpacked extension in a Chromium-compatible browser;
- verify a public CNB repository;
- verify a private CNB repository available to the signed-in user;
- navigate files through both CNB and RepoTreeX and confirm synchronization;
- switch branch and tag and confirm tree replacement;
- search loaded nodes and exercise bounded full-tree loading;
- resize, collapse, refresh, and reload the page;
- sign out or revoke repository access and confirm data clearing;
- verify light/dark theme, keyboard navigation, and common viewport sizes.

Private-repository verification uses a repository selected by the user and does
not capture its directory names in screenshots, logs, fixtures, or reports.

## 12. Delivery

The implementation delivers:

- source and reproducible build scripts;
- a loadable unpacked-extension directory and release ZIP task;
- automated tests and lint/type checks;
- installation and browser-verification instructions;
- CNB OAuth application request notes for the fallback flow;
- a privacy statement explaining web-session reuse and non-persistence of
  repository metadata.

Chrome Web Store or QQ Browser store publication is outside the first
implementation unless separately requested. No external submission, OAuth
application registration, or installation occurs without the user's explicit
action at that point.
