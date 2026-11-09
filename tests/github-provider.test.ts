import { describe, expect, it, vi } from "vitest";
import { createGitHubProvider } from "../src/platforms/github/provider";
import { RepositoryError } from "../src/shared/errors";
import {
  githubBranchesHtmlFixture,
  githubRootHtmlFixture,
  githubTagsHtmlFixture,
  githubTreeHtmlFixture,
} from "./fixtures/github";

const embeddedAttributes = 'type="application/json" data-target="react-app.embeddedData"';

function embedded(data: unknown): string {
  return `<script ${embeddedAttributes}>${JSON.stringify(data)}</script>`;
}

function branchesPage(page: number, names: string[], hasMore: boolean): string {
  return embedded({
    payload: {
      current_page: page,
      has_more: hasMore,
      per_page: 20,
      branches: names.map((name) => ({ name, path: `/acme/repo/tree/${name}` })),
    },
  });
}

function tagsPage(tags: { name: string; sha: string }[], nextCursor?: string): string {
  const rows = tags.map(({ name, sha }) => [
    '<div class="Box-row">',
    `<h2><a class="Link--primary" href="/acme/repo/releases/tag/${encodeURIComponent(name)}">${name}</a></h2>`,
    `<a href="/acme/repo/commit/${sha}">${sha}</a>`,
    "</div>",
  ].join("")).join("");
  const next = nextCursor === undefined ? "" :
    `<a rel="next" href="/acme/repo/tags?after=${encodeURIComponent(nextCursor)}">next</a>`;
  return `<rails-partial data-partial-name="tagsIndexRoute.Results">${rows}${next}</rails-partial>`;
}

function providerFor(...responses: string[]) {
  const request = vi.fn();
  for (const response of responses) request.mockResolvedValueOnce(response);
  const dispose = vi.fn();
  return { provider: createGitHubProvider({ request, dispose }), request, dispose };
}

describe("GitHub provider", () => {
  it("loads head and directories through exact repository-page operations", async () => {
    const { provider, request } = providerFor(
      githubRootHtmlFixture,
      githubRootHtmlFixture,
      githubTreeHtmlFixture,
    );
    await expect(provider.getHead("acme/repo")).resolves.toBe("main");
    await expect(provider.listDirectory("acme/repo", "main", "")).resolves.toEqual({
      path: "", sha: "synthetic-root-sha",
      entries: [{ kind: "directory", name: "src", path: "src", sha: null }],
    });
    const controller = new AbortController();
    await expect(provider.listDirectory("acme/repo", "main", "src", controller.signal)).resolves.toEqual({
      path: "src", sha: "synthetic-tree-sha",
      entries: [{ kind: "file", name: "a.ts", path: "src/a.ts", sha: null }],
    });
    expect(request.mock.calls).toEqual([
      [{ platform: "github", type: "repository-page", repository: "acme/repo", ref: null, path: "", view: "root" }, { signal: undefined }],
      [{ platform: "github", type: "repository-page", repository: "acme/repo", ref: null, path: "", view: "root" }, { signal: undefined }],
      [{ platform: "github", type: "repository-page", repository: "acme/repo", ref: "main", path: "src", view: "tree" }, { signal: controller.signal }],
    ]);
  });

  it("paginates branch pages, deduplicates by name, and sorts copied refs", async () => {
    const firstNames = Array.from({ length: 100 }, (_, index) => `ref-${String(index).padStart(3, "0")}`);
    const { provider, request } = providerFor(
      branchesPage(1, firstNames, true),
      branchesPage(2, ["ref-050", "aaa", "zzz"], false),
    );
    const result = await provider.listBranches("acme/repo");
    expect(result).toHaveLength(102);
    expect(result[0]).toEqual({ kind: "branch", name: "aaa", sha: null });
    expect(result.find((ref) => ref.name === "ref-050")).toEqual({
      kind: "branch", name: "ref-050", sha: null,
    });
    expect(result.at(-1)).toEqual({ kind: "branch", name: "zzz", sha: null });
    expect(request.mock.calls).toEqual([1, 2].map((page) => [{
      platform: "github", type: "refs-page", repository: "acme/repo", kind: "branches", page,
    }, { signal: undefined }]));
  });

  it("paginates tags by the observed cursor and keeps the first duplicate", async () => {
    const { provider, request } = providerFor(
      tagsPage([{ name: "v2", sha: "v2-sha" }, { name: "v1", sha: "v1-sha" }], "v2"),
      tagsPage([{ name: "v2", sha: "changed-sha" }, { name: "v3", sha: "v3-sha" }]),
    );
    await expect(provider.listTags("acme/repo")).resolves.toEqual([
      { kind: "tag", name: "v1", sha: "v1-sha" },
      { kind: "tag", name: "v2", sha: "v2-sha" },
      { kind: "tag", name: "v3", sha: "v3-sha" },
    ]);
    expect(request.mock.calls).toEqual([
      [{ platform: "github", type: "refs-page", repository: "acme/repo", kind: "tags", after: null }, { signal: undefined }],
      [{ platform: "github", type: "refs-page", repository: "acme/repo", kind: "tags", after: "v2" }, { signal: undefined }],
    ]);
  });

  it.each(["listBranches", "listTags"] as const)(
    "%s fails explicitly when bounded pagination is incomplete",
    async (method) => {
      const responses = method === "listBranches"
        ? Array.from({ length: 10 }, (_, index) => branchesPage(index + 1, [`page-${index}`], true))
        : Array.from({ length: 10 }, (_, index) => tagsPage(
          [{ name: `tag-${index}`, sha: `sha-${index}` }], `cursor-${index}`,
        ));
      const { provider, request } = providerFor(...responses);
      await expect(provider[method]("acme/repo")).rejects.toMatchObject({ code: "compatibility" });
      expect(request).toHaveBeenCalledTimes(10);
    },
  );

  it("rejects a repeated tag cursor instead of looping or returning partial refs", async () => {
    const { provider, request } = providerFor(
      tagsPage([{ name: "v1", sha: "v1-sha" }], "same"),
      tagsPage([{ name: "v2", sha: "v2-sha" }], "same"),
    );
    await expect(provider.listTags("acme/repo")).rejects.toMatchObject({ code: "compatibility" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("propagates a later page failure without returning partial refs", async () => {
    const error = new RepositoryError("rate-limited", { status: 429 });
    const request = vi.fn()
      .mockResolvedValueOnce(branchesPage(1, ["main"], true))
      .mockRejectedValueOnce(error);
    const provider = createGitHubProvider({ request, dispose: vi.fn() });
    await expect(provider.listBranches("acme/repo")).rejects.toBe(error);
  });

  it("honors cancellation before a request and after a late client resolution", async () => {
    const preAborted = new AbortController();
    preAborted.abort("private reason");
    const first = providerFor(githubRootHtmlFixture);
    await expect(first.provider.getHead("acme/repo", preAborted.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(first.request).not.toHaveBeenCalled();

    const late = new AbortController();
    const request = vi.fn().mockImplementation(async () => {
      late.abort("private reason");
      return githubBranchesHtmlFixture;
    });
    const provider = createGitHubProvider({ request, dispose: vi.fn() });
    await expect(provider.listBranches("acme/repo", late.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("fails closed on non-text client values and malformed decoded pages", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ format: "text", text: githubRootHtmlFixture })
      .mockResolvedValueOnce("<html></html>");
    const provider = createGitHubProvider({ request, dispose: vi.fn() });
    await expect(provider.getHead("acme/repo")).rejects.toMatchObject({ code: "compatibility" });
    await expect(provider.listTags("acme/repo")).rejects.toMatchObject({ code: "compatibility" });
  });

  it("disposes the bridge once and cancels later operations", async () => {
    const { provider, request, dispose } = providerFor(githubTagsHtmlFixture);
    provider.dispose();
    provider.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(provider.listTags("acme/repo")).rejects.toMatchObject({ code: "cancelled" });
    expect(request).not.toHaveBeenCalled();
  });
});
