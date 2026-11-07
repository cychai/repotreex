# RepoTreeX for CNB

RepoTreeX is an unpacked Manifest V3 extension that adds a repository tree to
supported CNB repository pages. Version 0.1.0 uses the current CNB browser
session for read-only, same-origin requests. It is not published in the Chrome
Web Store or QQ Browser store, and OAuth is not active.

## Prerequisites

- Node.js 24.15 or later in the Node 24 release line
- npm
- `zip` and `unzip` for release packaging and inspection
- QQ Browser or Chrome with extension developer mode available
- CNB access appropriate for each repository being viewed

Install the locked development dependencies and validate the checkout:

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm run package
unzip -l dist/repotreex-0.1.0.zip
```

`npm run package` rebuilds the extension and writes both the unpacked extension
to `dist/extension/` and the release archive to
`dist/repotreex-0.1.0.zip`. The ZIP is a release artifact for inspection or
controlled distribution; it is not evidence of store publication.

## Load the unpacked extension

1. Run `npm run build` or `npm run package`.
2. Open QQ Browser's extension-management page or Chrome's
   `chrome://extensions` page.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the absolute `dist/extension/` directory from this checkout.
6. Open or reload a supported `https://cnb.cool/` repository page.

After rebuilding, use the extension page's **Reload** action and then reload
the CNB tab. Installation and removal are user actions; the project does not
perform them automatically.

## Supported routes and usage

RepoTreeX currently activates on CNB repository roots, blob/file routes, and
single-commit routes for nested repository slugs. Repository roots and commit
routes resolve the repository HEAD. Blob routes synchronize the current ref and
file, including discovered branch or tag names that contain slashes. Other CNB
routes stay untouched.

The first release provides:

- a left-side, resizable and collapsible repository tree;
- lazy directory expansion and current-file reveal;
- file navigation through canonical CNB blob URLs;
- branch and tag selection;
- case-insensitive search across nodes already loaded in the tab;
- optional bounded full-tree loading for search, with progress, cancellation,
  a 10,000-node ceiling, and explicit truncation;
- keyboard tree controls, light/dark appearance, and retryable error states;
- persistence of only panel open/closed state and panel width.

The primary data path calls only allowlisted read-only CNB endpoints for HEAD,
branches, tags, and repository contents. Current CNB session cookies are
attached by the browser to same-origin requests; RepoTreeX does not read or
export cookies. See [Privacy](docs/privacy.md) and the
[manual verification matrix](docs/manual-test.md).

## Known limits

- Live CNB endpoint schema, private-repository access, logout behavior, QQ
  Browser compatibility, and CNB layout variants require manual acceptance in
  the target browser.
- OAuth controls are absent and remain disabled until CNB approves and supplies
  a real public-client registration. See
  [OAuth application request](docs/oauth-application.md).
- Search matches file/path names, not file contents. Only loaded nodes are
  searched unless the user starts bounded full-tree loading.
- Full-tree loading is capped and can report a truncated result; large
  repositories are not promised to be fully indexed.
- A browser request already sent before navigation or cancellation may finish,
  but late results are ignored and repository structure is not persisted.
- Store publication, automatic updates, full-text search, multiple file tabs,
  bookmarks, file history, and merge-request change trees are not implemented.

## Clean-room boundary

RepoTreeX is an independent implementation based on CNB public/documented
interfaces and observed product behavior. It does not include copied,
decompiled, transformed, or derived Octotree source code, assets, identifiers,
or proprietary protocols. Octotree is only a user-experience reference.
