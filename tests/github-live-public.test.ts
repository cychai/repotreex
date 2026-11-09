import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  decodeGitHubRefsPage,
  decodeGitHubRepositoryPage,
} from "../src/platforms/github/decoder";

const fixtureDirectory = process.env.REPOTREEX_GITHUB_LIVE_FIXTURE_DIR;
const live = fixtureDirectory === undefined ? describe.skip : describe;

live("GitHub current public HTML", () => {
  it("decodes cychai/notivue root, branches, tags, and a nested directory", async () => {
    const [root, branches, tags, tree] = await Promise.all([
      readFile(`${fixtureDirectory}/root.html`, "utf8"),
      readFile(`${fixtureDirectory}/branches.html`, "utf8"),
      readFile(`${fixtureDirectory}/tags.html`, "utf8"),
      readFile(`${fixtureDirectory}/tree.html`, "utf8"),
    ]);

    const repository = "cychai/notivue";
    const rootPage = decodeGitHubRepositoryPage(root, {
      repository, ref: null, path: "", view: "root",
    });
    expect(rootPage.head).toBe("main");
    expect(rootPage.listing.path).toBe("");
    expect(rootPage.listing.entries.some((entry) => entry.path === "assets")).toBe(true);

    expect(decodeGitHubRefsPage(branches, {
      kind: "branches", repository, page: 1,
    }).refs).toContainEqual({ name: "main", sha: null });
    expect(decodeGitHubRefsPage(tags, {
      kind: "tags", repository, after: null,
    }).refs.some((ref) => ref.name === "v0.1.0")).toBe(true);

    const treePage = decodeGitHubRepositoryPage(tree, {
      repository, ref: "main", path: "assets", view: "tree",
    });
    expect(treePage.listing.path).toBe("assets");
    expect(treePage.listing.entries.length).toBeGreaterThan(0);
  });
});
