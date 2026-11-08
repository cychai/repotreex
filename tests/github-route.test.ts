import { describe, expect, it } from "vitest";
import {
  buildGitHubFileUrl,
  buildGitHubRefRootUrl,
  parseGitHubRoute,
  reconcileGitHubRoute,
} from "../src/platforms/github/route";

describe("parseGitHubRoute", () => {
  it.each([
    ["https://github.com/acme/repo", { view: "root", ref: null, path: null }],
    ["https://github.com/acme/repo/", { view: "root", ref: null, path: null }],
    ["https://github.com/acme/repo/tree/main/src", { view: "tree", ref: "main", path: "src" }],
    ["https://github.com/acme/repo/blob/main/src/a%20b.ts", {
      view: "blob", ref: "main", path: "src/a b.ts",
    }],
  ])("parses %s", (href, expected) => {
    expect(parseGitHubRoute(new URL(href))).toMatchObject({
      platform: "github",
      repository: "acme/repo",
      ...expected,
    });
  });

  it("uses a known slash ref only when its complete decoded prefix matches", () => {
    const matching = new URL("https://github.com/acme/repo/blob/release/v1/src/app.ts");
    const nonMatching = new URL("https://github.com/acme/repo/blob/release/v10/src/app.ts");

    expect(parseGitHubRoute(matching, { knownRef: "release/v1" })).toMatchObject({
      ref: "release/v1",
      path: "src/app.ts",
    });
    expect(parseGitHubRoute(nonMatching, { knownRef: "release/v1" })).toMatchObject({
      ref: "release",
      path: "v10/src/app.ts",
    });
  });

  it("matches known refs against decoded route segments", () => {
    expect(parseGitHubRoute(
      new URL("https://github.com/acme/repo/blob/release%20train/v1/src/app.ts"),
      { knownRef: "release train/v1" },
    )).toMatchObject({ ref: "release train/v1", path: "src/app.ts" });
  });

  it("keeps the first suffix segment as the provisional ref", () => {
    expect(parseGitHubRoute(
      new URL("https://github.com/acme/repo/tree/release/v1/src"),
      { knownRef: "main" },
    )).toMatchObject({ ref: "release", path: "v1/src" });
  });

  it("documents that URL normalization makes directly encoded dot segments unobservable", () => {
    const url = new URL(
      "https://github.com/acme/repo/blob/main/src/%2e%2e/secret.ts",
    );

    expect(url.pathname).toBe("/acme/repo/blob/main/secret.ts");
    expect(parseGitHubRoute(url)).toMatchObject({
      ref: "main",
      path: "secret.ts",
    });
  });

  it.each([
    "issues", "pulls", "actions", "projects", "wiki", "security", "pulse", "graphs",
    "settings", "releases", "commits", "branches", "tags", "network", "stargazers",
    "watchers", "forks", "insights",
  ])("rejects the non-code route %s", (section) => {
    expect(parseGitHubRoute(new URL(`https://github.com/acme/repo/${section}`))).toEqual({
      kind: "unsupported",
    });
  });

  it.each([
    "http://github.com/acme/repo",
    "https://www.github.com/acme/repo",
    "https://github.com:444/acme/repo",
    "https://user@github.com/acme/repo",
    "https://user:secret@github.com/acme/repo",
    "https://github.com/acme",
    "https://github.com/acme//repo",
    "https://github.com/acme/repo/extra",
    "https://github.com/acme/repo/tree",
    "https://github.com/acme/repo/blob",
  ])("rejects an invalid GitHub route %s", (href) => {
    expect(parseGitHubRoute(new URL(href))).toEqual({ kind: "unsupported" });
  });

  it.each([
    "https://github.com/acme%2Frepo/project",
    "https://github.com/acme/repo%2Fother",
    "https://github.com/acme/repo/blob/main/src%2Fa.ts",
    "https://github.com/acme/repo/blob/main/src%5Ca.ts",
    "https://github.com/acme/repo/blob/main/src/%00a.ts",
    "https://github.com/acme/repo/blob/main/src/%C2%85a.ts",
    "https://github.com/%252e%252e/repo",
    "https://github.com/%252E%252E/repo",
    "https://github.com/acme/%252e",
    "https://github.com/acme/%252E",
    "https://github.com/acme/repo/blob/main/%252e/a.ts",
    "https://github.com/acme/repo/blob/main/%252E/a.ts",
    "https://github.com/acme/repo/blob/main/src/%252e%252e/a.ts",
    "https://github.com/acme/repo/blob/main/src/%252E%252E/a.ts",
    "https://github.com/acme/repo%ZZ",
    "https://github.com/acme/repo/blob/main/file%ZZ.ts",
  ])("rejects an unsafe encoded boundary %s", (href) => {
    expect(parseGitHubRoute(new URL(href))).toEqual({ kind: "unsupported" });
  });

  it("rejects unsafe known refs instead of changing the route boundary", () => {
    const url = new URL("https://github.com/acme/repo/blob/release/v1/src/app.ts");
    for (const knownRef of ["release/../v1", "release//v1", "release\\v1", "release\nv1"]) {
      expect(parseGitHubRoute(url, { knownRef })).toMatchObject({
        ref: "release",
        path: "v1/src/app.ts",
      });
    }
  });

  it("returns a fresh immutable unsupported result", () => {
    const first = parseGitHubRoute(new URL("https://example.com/acme/repo"));
    const second = parseGitHubRoute(new URL("https://example.com/acme/repo"));

    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
  });
});

describe("reconcileGitHubRoute", () => {
  it("resolves the longest discovered branch or tag prefix", () => {
    const refs = ["release", "release/v1", "release/v1/patch"].map((name) => ({
      kind: "branch" as const,
      name,
      sha: "synthetic",
    }));

    expect(reconcileGitHubRoute(
      new URL("https://github.com/acme/repo/blob/release/v1/patch/src/app.ts"),
      refs,
      "main",
    )).toMatchObject({ ref: "release/v1/patch", path: "src/app.ts" });
  });

  it("falls back to the provisional ref when no discovered ref matches", () => {
    expect(reconcileGitHubRoute(
      new URL("https://github.com/acme/repo/tree/topic/src"),
      [{ kind: "tag", name: "v1", sha: "synthetic" }],
      "main",
    )).toMatchObject({ ref: "topic", path: "src" });
  });
});

describe("GitHub native URL builders", () => {
  const route = {
    platform: "github", view: "root", repository: "acme/repo", ref: null, path: null,
  } as const;

  it("encodes refs and paths one segment at a time", () => {
    expect(buildGitHubFileUrl(route, "release/v1", "src/a b.ts").href).toBe(
      "https://github.com/acme/repo/blob/release/v1/src/a%20b.ts",
    );
    expect(buildGitHubRefRootUrl(route, "release/v1").href).toBe(
      "https://github.com/acme/repo/tree/release/v1",
    );
  });

  it("round-trips literal percent characters without creating encoded boundaries", () => {
    const url = buildGitHubFileUrl(route, "release%2Fv1", "docs/100%.md");

    expect(url.href).toBe(
      "https://github.com/acme/repo/blob/release%252Fv1/docs/100%25.md",
    );
    expect(parseGitHubRoute(url, { knownRef: "release%2Fv1" })).toMatchObject({
      ref: "release%2Fv1",
      path: "docs/100%.md",
    });
  });

  it.each([".", ".."])('rejects the decoded dot segment "%s" in semantic inputs', (segment) => {
    expect(() => buildGitHubFileUrl(route, segment, "src/app.ts")).toThrow(TypeError);
    expect(() => buildGitHubFileUrl(route, "main", `src/${segment}/app.ts`)).toThrow(TypeError);
    expect(() => buildGitHubRefRootUrl(route, `release/${segment}/next`)).toThrow(TypeError);
  });

  it("rejects the wrong platform and unsafe repository, ref, or path values", () => {
    expect(() => buildGitHubFileUrl(
      { ...route, platform: "cnb" }, "main", "src/app.ts",
    )).toThrow(TypeError);

    for (const repository of ["", "acme", "acme/repo/extra", "acme//repo", "acme/../repo"]) {
      expect(() => buildGitHubFileUrl(
        { ...route, repository }, "main", "src/app.ts",
      )).toThrow(TypeError);
    }
    for (const ref of ["", "/main", "main/", "main//next", ".", "..", "main/../next", "main\\next"]) {
      expect(() => buildGitHubFileUrl(route, ref, "src/app.ts")).toThrow(TypeError);
    }
    for (const path of ["", "/src/app.ts", "src/app.ts/", "src//app.ts", ".", "..", "src/../app.ts", "src\\app.ts"]) {
      expect(() => buildGitHubFileUrl(route, "main", path)).toThrow(TypeError);
    }
    expect(() => buildGitHubRefRootUrl(route, "main/../next")).toThrow(TypeError);
  });
});
