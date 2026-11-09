// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  githubBranchesHtmlFixture,
  githubFixtures,
  githubLoginHtmlFixture,
  githubNotFoundHtmlFixture,
  githubRootHtmlFixture,
  githubTagsHtmlFixture,
  githubTreeHtmlFixture,
} from "./fixtures/github";

const embeddedDataSelector =
  'script[type="application/json"][data-target="react-app.embeddedData"]';
const tagRowSelector =
  'rails-partial[data-partial-name="tagsIndexRoute.Results"] .Box-row';

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function embeddedData(html: string): unknown {
  const node = parseHtml(html).querySelector(embeddedDataSelector);
  expect(node).not.toBeNull();
  return JSON.parse(node?.textContent ?? "");
}

describe("synthetic GitHub fixtures", () => {
  it("keeps GitHub fixtures synthetic and credential-free", () => {
    const joined = githubFixtures.join("\n");
    expect(joined).not.toContain("octocat");
    expect(joined).not.toContain("Hello-World");
    expect(joined).not.toMatch(/cookie|authorization|bearer|user[_-]?login/i);
    expect(joined).toContain("acme/repo");
  });

  it("models root and tree embedded-data paths without captured page content", () => {
    expect(embeddedData(githubRootHtmlFixture)).toMatchObject({
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
    expect(embeddedData(githubTreeHtmlFixture)).toMatchObject({
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
  });

  it("models branch embedded-data pagination paths", () => {
    expect(embeddedData(githubBranchesHtmlFixture)).toEqual({
      payload: {
        current_page: 1,
        has_more: false,
        per_page: 100,
        branches: [{ name: "release/v1", path: "/acme/repo/tree/release/v1" }],
      },
    });
  });

  it("models tag rows and cursor links through observed selectors", () => {
    const document = parseHtml(githubTagsHtmlFixture);
    const row = document.querySelector(tagRowSelector);
    const tagLink = row?.querySelector("h2 a.Link--primary");
    expect(tagLink?.textContent).toBe("release/v1");
    expect(tagLink?.getAttribute("href")).toMatch(/^\/acme\/repo\/releases\/tag\//);
    expect(row?.querySelector('a[href^="/acme/repo/commit/"]')?.getAttribute("href")).toBe(
      "/acme/repo/commit/synthetic-tag-sha",
    );
    expect(document.querySelector('a[rel="next"][href*="after="]')?.getAttribute("href")).toBe(
      "/acme/repo/tags?after=release%2Fv1",
    );
  });

  it("keeps login and not-found fixtures outside the accepted data selector", () => {
    const login = parseHtml(githubLoginHtmlFixture);
    const notFound = parseHtml(githubNotFoundHtmlFixture);
    expect(login.querySelector('form[action="/session"] input[name="login"]')).not.toBeNull();
    expect(login.querySelector(embeddedDataSelector)).toBeNull();
    expect(notFound.querySelector(embeddedDataSelector)).toBeNull();
  });
});
