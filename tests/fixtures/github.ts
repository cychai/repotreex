const embeddedDataSelectorAttributes =
  'type="application/json" data-target="react-app.embeddedData"';

function embeddedDataFixture(data: unknown): string {
  return `<script ${embeddedDataSelectorAttributes}>${JSON.stringify(data)}</script>`;
}

export const githubRootHtmlFixture = embeddedDataFixture({
  payload: {
    codeViewRepoRoute: {
      refInfo: { name: "main", currentOid: "synthetic-root-sha" },
      path: "",
      tree: {
        items: [{ name: "src", path: "src", contentType: "directory" }],
      },
    },
  },
});

export const githubTreeHtmlFixture = embeddedDataFixture({
  payload: {
    codeViewTreeRoute: {
      refInfo: { name: "main", currentOid: "synthetic-tree-sha" },
      path: "src",
      tree: {
        items: [{ name: "a.ts", path: "src/a.ts", contentType: "file" }],
      },
    },
  },
});

export const githubBranchesHtmlFixture = embeddedDataFixture({
  payload: {
    current_page: 1,
    has_more: false,
    per_page: 100,
    branches: [{ name: "release/v1", path: "/acme/repo/tree/release/v1" }],
  },
});

export const githubTagsHtmlFixture = [
  '<meta name="repotreex-synthetic-repository" content="acme/repo">',
  '<rails-partial data-partial-name="tagsIndexRoute.Results">',
  '<div class="Box-row">',
  '<h2><a class="Link--primary" href="/acme/repo/releases/tag/release%2Fv1">release/v1</a></h2>',
  '<div class="commit"><a href="/acme/repo/commit/synthetic-tag-sha">synthetic-tag-sha</a></div>',
  '<a href="/acme/repo/archive/refs/tags/release%2Fv1.zip">zip</a>',
  '<a href="/acme/repo/archive/refs/tags/release%2Fv1.tar.gz">tar.gz</a>',
  '</div>',
  '<a rel="next" href="/acme/repo/tags?after=release%2Fv1">next</a>',
  '</rails-partial>',
].join("");

export const githubLoginHtmlFixture = [
  '<meta name="repotreex-synthetic-repository" content="acme/repo">',
  '<form action="/session" method="post">',
  '<input name="login" autocomplete="username">',
  '<input name="password" type="password">',
  '</form>',
].join("");

export const githubNotFoundHtmlFixture =
  '<meta name="repotreex-synthetic-repository" content="acme/repo"><main>Not Found</main>';

export const githubFixtures = [
  githubRootHtmlFixture,
  githubTreeHtmlFixture,
  githubBranchesHtmlFixture,
  githubTagsHtmlFixture,
  githubLoginHtmlFixture,
  githubNotFoundHtmlFixture,
] as const;
