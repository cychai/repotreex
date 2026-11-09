import { describe, expect, it } from "vitest";
import {
  decodeGitHubRefsPage,
  decodeGitHubRepositoryPage,
} from "../src/platforms/github/decoder";
import { RepositoryError } from "../src/shared/errors";
import {
  githubBranchesHtmlFixture,
  githubLoginHtmlFixture,
  githubNotFoundHtmlFixture,
  githubRootHtmlFixture,
  githubTagsHtmlFixture,
  githubTreeHtmlFixture,
} from "./fixtures/github";

const embeddedAttributes = 'type="application/json" data-target="react-app.embeddedData"';
const expectedRoot = { repository: "acme/repo", ref: null, path: "", view: "root" } as const;
const expectedTree = { repository: "acme/repo", ref: "main", path: "src", view: "tree" } as const;

function embedded(data: unknown): string {
  return `<script ${embeddedAttributes}>${JSON.stringify(data)}</script>`;
}

function expectCompatibility(run: () => unknown): void {
  expect(run).toThrowError(RepositoryError);
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject({ code: "compatibility", message: "compatibility" });
    expect(Object.keys(error as object)).toEqual(["code"]);
  }
}

describe("GitHub HTML decoder", () => {
  it("decodes root and tree pages into copied normalized scalars", () => {
    expect(decodeGitHubRepositoryPage(githubRootHtmlFixture, expectedRoot)).toEqual({
      head: "main",
      listing: {
        path: "",
        sha: "synthetic-root-sha",
        entries: [{ kind: "directory", name: "src", path: "src", sha: null }],
      },
    });
    expect(decodeGitHubRepositoryPage(githubTreeHtmlFixture, expectedTree)).toEqual({
      head: "main",
      listing: {
        path: "src",
        sha: "synthetic-tree-sha",
        entries: [{ kind: "file", name: "a.ts", path: "src/a.ts", sha: null }],
      },
    });
  });

  it("relies on request context rather than unobserved repository metadata", () => {
    const html = githubTreeHtmlFixture.replace(
      '"payload":', '"repository":"other/repository","payload":',
    );
    expect(decodeGitHubRepositoryPage(html, expectedTree)).toEqual({
      head: "main",
      listing: {
        path: "src", sha: "synthetic-tree-sha",
        entries: [{ kind: "file", name: "a.ts", path: "src/a.ts", sha: null }],
      },
    });
  });

  it.each([
    "",
    "<html></html>",
    githubLoginHtmlFixture,
    githubNotFoundHtmlFixture,
    githubTreeHtmlFixture.replace("synthetic-tree-sha", ""),
    githubTreeHtmlFixture.replace('"contentType":"file"', '"contentType":"socket"'),
    githubTreeHtmlFixture.replace('"path":"src/a.ts"', '"path":"other/a.ts"'),
    githubTreeHtmlFixture.replace('"name":"a.ts"', '"name":"b.ts"'),
  ])("fails closed on unsupported repository HTML %#", (html) => {
    expectCompatibility(() => decodeGitHubRepositoryPage(html, expectedTree));
  });

  it("rejects a duplicate embedded-data node and duplicate JSON keys", () => {
    expectCompatibility(() => decodeGitHubRepositoryPage(
      githubTreeHtmlFixture + githubTreeHtmlFixture,
      expectedTree,
    ));
    const duplicateKey = githubTreeHtmlFixture.replace(
      '"path":"src",',
      '"path":"src","path":"src",',
    );
    expectCompatibility(() => decodeGitHubRepositoryPage(duplicateKey, expectedTree));
    const nestedDuplicate = githubTreeHtmlFixture.replace(
      '"refInfo":{"name":"main"',
      '"refInfo":{"name":"main","name":"main"',
    );
    expectCompatibility(() => decodeGitHubRepositoryPage(nestedDuplicate, expectedTree));
  });

  it("rejects malformed JSON and exact-route mismatches", () => {
    expectCompatibility(() => decodeGitHubRepositoryPage(
      `<script ${embeddedAttributes}>{</script>`,
      expectedTree,
    ));
    expect(decodeGitHubRepositoryPage(
      `<script ${embeddedAttributes}>{"payload":{"codeViewTreeRoute":{"refInfo":{"name":"main","currentOid":"tree"},"path":"src","tree":{"items":[{"name":"a.ts","path":"src/a.ts","contentType":"file"}]}}},"marker":"[}{,\\"quoted\\":true}"}</script>`,
      expectedTree,
    ).head).toBe("main");
    expectCompatibility(() => decodeGitHubRepositoryPage(githubTreeHtmlFixture, {
      ...expectedTree, ref: "release/v1",
    }));
    expectCompatibility(() => decodeGitHubRepositoryPage(githubTreeHtmlFixture, {
      ...expectedTree, path: "docs",
    }));
    expectCompatibility(() => decodeGitHubRepositoryPage(githubRootHtmlFixture, {
      ...expectedRoot, view: "tree", ref: "main",
    }));
  });

  it("rejects escaped, duplicate, sparse-equivalent, and oversized listings", () => {
    const route = {
      refInfo: { name: "main", currentOid: "tree-oid" },
      path: "src",
      tree: { items: [
        { name: "a.ts", path: "src/a.ts", contentType: "file" },
        { name: "a.ts", path: "src/a.ts", contentType: "file" },
      ] },
    };
    expectCompatibility(() => decodeGitHubRepositoryPage(embedded({
      payload: { codeViewTreeRoute: route },
    }), expectedTree));

    const items = Array.from({ length: 10_001 }, (_, index) => ({
      name: `${index}.ts`, path: `src/${index}.ts`, contentType: "file",
    }));
    expectCompatibility(() => decodeGitHubRepositoryPage(embedded({
      payload: { codeViewTreeRoute: { ...route, tree: { items } } },
    }), expectedTree));
  });

  it("enforces the bounded HTML input before parsing", () => {
    expectCompatibility(() => decodeGitHubRepositoryPage("x".repeat(2_000_001), expectedRoot));
    expectCompatibility(() => decodeGitHubRepositoryPage(42 as never, expectedRoot));
  });

  it("drops unknown metadata and does not retain or mutate decoded values", () => {
    const html = embedded({
      payload: {
        codeViewTreeRoute: {
          refInfo: { name: "main", currentOid: "tree-oid", private: "drop-me" },
          path: "src",
          tree: { items: [{
            name: "a.ts", path: "src/a.ts", contentType: "file", private: "drop-me",
          }] },
          private: "drop-me",
        },
      },
      repository: "acme/repo",
      private: "drop-me",
    });
    const first = decodeGitHubRepositoryPage(html, expectedTree);
    first.head = "changed";
    first.listing.entries[0].name = "changed";
    const second = decodeGitHubRepositoryPage(html, expectedTree);
    expect(second).toEqual({
      head: "main",
      listing: {
        path: "src", sha: "tree-oid",
        entries: [{ kind: "file", name: "a.ts", path: "src/a.ts", sha: null }],
      },
    });
    expect(JSON.stringify(second)).not.toContain("drop-me");
  });

  it("decodes the observed branch page and validates its repository paths", () => {
    expect(decodeGitHubRefsPage(githubBranchesHtmlFixture, {
      kind: "branches", repository: "acme/repo", page: 1,
    })).toEqual({
      refs: [{ name: "release/v1", sha: null }],
      hasNextPage: false,
    });
    expectCompatibility(() => decodeGitHubRefsPage(githubBranchesHtmlFixture, {
      kind: "branches", repository: "acme/other", page: 1,
    }));
    expectCompatibility(() => decodeGitHubRefsPage(githubBranchesHtmlFixture, {
      kind: "branches", repository: "acme/repo", page: 2,
    }));
  });

  it("rejects malformed branch pagination and duplicate branch names", () => {
    const page = (payload: Record<string, unknown>) => embedded({ payload });
    expectCompatibility(() => decodeGitHubRefsPage(page({
      current_page: 1, has_more: "false", per_page: 100, branches: [],
    }), { kind: "branches", repository: "acme/repo", page: 1 }));
    expectCompatibility(() => decodeGitHubRefsPage(page({
      current_page: 1, has_more: false, per_page: 50, branches: [],
    }), { kind: "branches", repository: "acme/repo", page: 1 }));
    expectCompatibility(() => decodeGitHubRefsPage(page({
      current_page: 1, has_more: false, per_page: 100,
      branches: [
        { name: "main", path: "/acme/repo/tree/main" },
        { name: "main", path: "/acme/repo/tree/main" },
      ],
    }), { kind: "branches", repository: "acme/repo", page: 1 }));
  });

  it("decodes observed tag rows and copies the exact next cursor", () => {
    expect(decodeGitHubRefsPage(githubTagsHtmlFixture, {
      kind: "tags", repository: "acme/repo", after: null,
    })).toEqual({
      refs: [{ name: "release/v1", sha: "synthetic-tag-sha" }],
      hasNextPage: true,
      nextCursor: "release/v1",
    });
    expectCompatibility(() => decodeGitHubRefsPage(githubTagsHtmlFixture, {
      kind: "tags", repository: "acme/other", after: null,
    }));
  });

  it.each([
    githubTagsHtmlFixture.replace("synthetic-tag-sha", ""),
    githubTagsHtmlFixture.replace("/acme/repo/commit/", "/acme/other/commit/"),
    githubTagsHtmlFixture.replace("?after=release%2Fv1", "?after="),
    githubTagsHtmlFixture.replace("?after=release%2Fv1", "?after=one&after=two"),
    githubTagsHtmlFixture.replace("release/v1</a></h2>", "</a></h2>"),
  ])("rejects malformed tag shapes %#", (html) => {
    expectCompatibility(() => decodeGitHubRefsPage(html, {
      kind: "tags", repository: "acme/repo", after: null,
    }));
  });

  it("rejects duplicate tag names before provider-level cross-page deduplication", () => {
    const duplicate = githubTagsHtmlFixture.replace(
      '<a rel="next" href="/acme/repo/tags?after=release%2Fv1">next</a>',
      (githubTagsHtmlFixture.match(/<div class="Box-row">.*?<\/div>/)?.[0] ?? "")
        .replaceAll("synthetic-tag-sha", "second-sha"),
    );
    expectCompatibility(() => decodeGitHubRefsPage(duplicate, {
      kind: "tags", repository: "acme/repo", after: null,
    }));
  });

  it("accepts nested rows under the exact observed tag row selector", () => {
    const nested = githubTagsHtmlFixture
      .replace('<div class="Box-row">', '<section><div class="Box-row">')
      .replace('</div><a rel="next"', '</div></section><a rel="next"');
    expect(decodeGitHubRefsPage(nested, {
      kind: "tags", repository: "acme/repo", after: null,
    })).toEqual({
      refs: [{ name: "release/v1", sha: "synthetic-tag-sha" }],
      hasNextPage: true,
      nextCursor: "release/v1",
    });
  });

  it("snapshots ref expectations without invoking accessors or leaking proxy failures", () => {
    let reads = 0;
    const accessor = Object.defineProperty({
      repository: "acme/repo", page: 1,
    }, "kind", {
      enumerable: true,
      get() { reads++; return "branches"; },
    });
    expectCompatibility(() => decodeGitHubRefsPage(githubBranchesHtmlFixture, accessor as never));
    expect(reads).toBe(0);

    const hostile = new Proxy({ kind: "branches", repository: "acme/repo", page: 1 }, {
      getOwnPropertyDescriptor() {
        throw new Error("private proxy failure");
      },
    });
    expectCompatibility(() => decodeGitHubRefsPage(githubBranchesHtmlFixture, hostile as never));
  });

  it("fails closed when DOM selector or attribute inspection throws", () => {
    const original = DOMParser.prototype.parseFromString;
    DOMParser.prototype.parseFromString = () => new Proxy({} as Document, {
      get() {
        throw new Error("private hostile document");
      },
    });
    try {
      expectCompatibility(() => decodeGitHubRepositoryPage(githubTreeHtmlFixture, expectedTree));
      expectCompatibility(() => decodeGitHubRefsPage(githubTagsHtmlFixture, {
        kind: "tags", repository: "acme/repo", after: null,
      }));
    } finally {
      DOMParser.prototype.parseFromString = original;
    }
  });

  it("rejects ref pages over 100 records", () => {
    const branches = Array.from({ length: 101 }, (_, index) => ({
      name: `branch-${index}`, path: `/acme/repo/tree/branch-${index}`,
    }));
    expectCompatibility(() => decodeGitHubRefsPage(embedded({
      payload: { current_page: 1, has_more: false, per_page: 100, branches },
    }), { kind: "branches", repository: "acme/repo", page: 1 }));

    const row = githubTagsHtmlFixture.match(/<div class="Box-row">.*?<\/div>/)?.[0];
    expect(row).toBeDefined();
    const html = '<rails-partial data-partial-name="tagsIndexRoute.Results">' +
      Array.from({ length: 101 }, (_, index) => row
        ?.replaceAll("release/v1", `tag-${index}`)
        .replaceAll("release%2Fv1", `tag-${index}`)
        .replaceAll("synthetic-tag-sha", `sha-${index}`)).join("") +
      "</rails-partial>";
    expectCompatibility(() => decodeGitHubRefsPage(html, {
      kind: "tags", repository: "acme/repo", after: null,
    }));
  });
});
