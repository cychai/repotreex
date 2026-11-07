import { describe, expect, it } from "vitest";
import { buildBlobUrl, parseCnbRoute } from "../src/shared/route";

describe("parseCnbRoute", () => {
  it("parses a nested repository root without assuming owner/repo", () => {
    expect(parseCnbRoute(new URL("https://cnb.cool/acme/platform/web"))).toMatchObject({
      kind: "repository",
      repo: "acme/platform/web",
      ref: null,
      filePath: null,
    });
  });

  it("parses a blob route when route state supplies the ref boundary", () => {
    const url = new URL("https://cnb.cool/acme/platform/web/-/blob/main/src/a%20b.ts");
    expect(parseCnbRoute(url, { knownRef: "main" })).toMatchObject({
      kind: "blob",
      repo: "acme/platform/web",
      ref: "main",
      filePath: "src/a b.ts",
    });
  });

  it("uses a matching slash ref hint as the blob ref boundary", () => {
    const url = new URL("https://cnb.cool/acme/platform/web/-/blob/release/v1/src/index.ts");
    expect(parseCnbRoute(url, { knownRef: "release/v1" })).toEqual({
      kind: "blob",
      repo: "acme/platform/web",
      ref: "release/v1",
      filePath: "src/index.ts",
    });
  });

  it("round-trips a canonical encoded slash ref only with matching route evidence", () => {
    const route = { kind: "repository", repo: "acme/platform/web", ref: null, filePath: null } as const;
    const url = buildBlobUrl(route, "release/v1", "src/index.ts");

    expect(parseCnbRoute(url, { knownRef: "release/v1" })).toEqual({
      kind: "blob",
      repo: "acme/platform/web",
      ref: "release/v1",
      filePath: "src/index.ts",
    });
    expect(parseCnbRoute(url)).toEqual({ kind: "unsupported" });
    expect(parseCnbRoute(url, { knownRef: "release/../v1" })).toEqual({ kind: "unsupported" });
    expect(
      parseCnbRoute(new URL("https://cnb.cool/acme/repo/-/blob/main/src%2Findex.ts"), {
        knownRef: "main",
      }),
    ).toEqual({ kind: "unsupported" });
  });

  it("parses the first blob segment as a provisional ref without a matching hint", () => {
    const url = new URL("https://cnb.cool/acme/platform/web/-/blob/release/v1/src/index.ts");
    expect(parseCnbRoute(url, { knownRef: "main" })).toEqual({
      kind: "blob",
      repo: "acme/platform/web",
      ref: "release",
      filePath: "v1/src/index.ts",
    });
  });

  it("parses commit routes without treating the commit as a file ref", () => {
    expect(parseCnbRoute(new URL("https://cnb.cool/acme/platform/web/-/commit/abc123"))).toEqual({
      kind: "commit",
      repo: "acme/platform/web",
      ref: null,
      filePath: null,
    });
  });

  it("rejects unsupported markers and malformed encoded segments", () => {
    expect(parseCnbRoute(new URL("https://cnb.cool/acme/repo/-/branches"))).toEqual({
      kind: "unsupported",
    });
    expect(parseCnbRoute(new URL("https://cnb.cool/acme/repo%ZZ"))).toEqual({
      kind: "unsupported",
    });
    expect(parseCnbRoute(new URL("https://cnb.cool/acme%2Frepo/project"))).toEqual({
      kind: "unsupported",
    });
  });

  it("requires the exact HTTPS CNB origin and at least two repository segments", () => {
    const unsupportedUrls = [
      "http://cnb.cool/acme/repo",
      "https://www.cnb.cool/acme/repo",
      "https://cnb.cool:444/acme/repo",
      "https://user@cnb.cool/acme/repo",
      "https://user:secret@cnb.cool/acme/repo",
      "https://cnb.cool/acme",
      "https://cnb.cool/acme//repo",
      "https://cnb.cool/acme/repo/-/blob",
    ];

    for (const value of unsupportedUrls) {
      expect(parseCnbRoute(new URL(value))).toEqual({ kind: "unsupported" });
    }
  });

  it("rejects every known non-repository top-level route", () => {
    const routes = [
      "profile",
      "login",
      "oauth2",
      "explore",
      "new",
      "u",
      "search",
      "announcements",
      "invitations",
      "error",
      "forbidden",
      "freeze",
      "mine",
      "user-locked",
      "wx",
    ];

    for (const route of routes) {
      expect(parseCnbRoute(new URL(`https://cnb.cool/${route}/synthetic`))).toEqual({
        kind: "unsupported",
      });
    }
  });

  it("rejects non-CNB and non-repository routes", () => {
    expect(parseCnbRoute(new URL("https://example.com/acme/repo"))).toEqual({ kind: "unsupported" });
    expect(parseCnbRoute(new URL("https://cnb.cool/profile"))).toEqual({ kind: "unsupported" });
  });

  it("returns a fresh immutable unsupported result", () => {
    const first = parseCnbRoute(new URL("https://example.com/acme/repo"));
    const second = parseCnbRoute(new URL("https://example.com/acme/repo"));

    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
  });
});

describe("buildBlobUrl", () => {
  it("encodes each ref and path segment", () => {
    const route = { kind: "repository", repo: "acme/platform/web", ref: null, filePath: null } as const;
    expect(buildBlobUrl(route, "release/v1", "src/a b.ts").href).toBe(
      "https://cnb.cool/acme/platform/web/-/blob/release%2Fv1/src/a%20b.ts",
    );
  });

  it("reserves the dash marker only in repository segments", () => {
    const route = { kind: "repository", repo: "acme/repo", ref: null, filePath: null } as const;
    expect(buildBlobUrl(route, "release/-/v1", "src/-/a.ts").href).toBe(
      "https://cnb.cool/acme/repo/-/blob/release%2F-%2Fv1/src/-/a.ts",
    );
  });

  it("rejects unsafe repository, ref, and path inputs", () => {
    const validRoute = {
      kind: "repository",
      repo: "acme/platform/web",
      ref: null,
      filePath: null,
    } as const;
    const invalidRepositories = [
      "",
      "acme",
      "/acme/repo",
      "acme//repo",
      "acme/./repo",
      "acme/../repo",
      "acme\\repo",
      "acme/-/repo",
    ];
    const invalidRefs = [
      "",
      "/main",
      "main/",
      "main//next",
      ".",
      "..",
      "main/../next",
      "main\\next",
      "main\nnext",
    ];
    const invalidPaths = [
      "",
      "/src/a.ts",
      "src/a.ts/",
      "src//a.ts",
      ".",
      "..",
      "src/../a.ts",
      "src\\a.ts",
      "src\u0000a.ts",
    ];

    for (const repo of invalidRepositories) {
      expect(() => buildBlobUrl({ ...validRoute, repo }, "main", "src/a.ts")).toThrow(TypeError);
    }
    for (const ref of invalidRefs) {
      expect(() => buildBlobUrl(validRoute, ref, "src/a.ts")).toThrow(TypeError);
    }
    for (const path of invalidPaths) {
      expect(() => buildBlobUrl(validRoute, "main", path)).toThrow(TypeError);
    }
  });
});
