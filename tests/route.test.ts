import { describe, expect, it } from "vitest";
import {
  buildCnbFileUrl, buildCnbRefRootUrl, parseCnbRoute, reconcileCnbRoute,
} from "../src/platforms/cnb/route";
import { cnbAdapter } from "../src/platforms/cnb";

describe("parseCnbRoute", () => {
  it("parses a nested repository root without assuming owner/repo", () => {
    expect(parseCnbRoute(new URL("https://cnb.cool/acme/platform/web"))).toMatchObject({
      platform: "cnb",
      view: "root",
      repository: "acme/platform/web",
      ref: null,
      path: null,
    });
  });

  it("parses a blob route when route state supplies the ref boundary", () => {
    const url = new URL("https://cnb.cool/acme/platform/web/-/blob/main/src/a%20b.ts");
    expect(parseCnbRoute(url, { knownRef: "main" })).toMatchObject({
      platform: "cnb",
      view: "blob",
      repository: "acme/platform/web",
      ref: "main",
      path: "src/a b.ts",
    });
  });

  it("uses a matching slash ref hint as the blob ref boundary", () => {
    const url = new URL("https://cnb.cool/acme/platform/web/-/blob/release/v1/src/index.ts");
    expect(parseCnbRoute(url, { knownRef: "release/v1" })).toEqual({
      platform: "cnb",
      view: "blob",
      repository: "acme/platform/web",
      ref: "release/v1",
      path: "src/index.ts",
    });
  });

  it("round-trips a canonical encoded slash ref only with matching route evidence", () => {
    const route = {
      platform: "cnb", view: "root", repository: "acme/platform/web", ref: null, path: null,
    } as const;
    const url = buildCnbFileUrl(route, "release/v1", "src/index.ts");

    expect(parseCnbRoute(url, { knownRef: "release/v1" })).toEqual({
      platform: "cnb",
      view: "blob",
      repository: "acme/platform/web",
      ref: "release/v1",
      path: "src/index.ts",
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
      platform: "cnb",
      view: "blob",
      repository: "acme/platform/web",
      ref: "release",
      path: "v1/src/index.ts",
    });
  });

  it("parses commit routes without treating the commit as a file ref", () => {
    expect(parseCnbRoute(new URL("https://cnb.cool/acme/platform/web/-/commit/abc123"))).toEqual({
      platform: "cnb",
      view: "root",
      repository: "acme/platform/web",
      ref: null,
      path: null,
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

describe("buildCnbFileUrl", () => {
  it("builds the same canonical encoded CNB file URL", () => {
    const route = {
      platform: "cnb", view: "root", repository: "acme/platform/web", ref: null, path: null,
    } as const;
    expect(buildCnbFileUrl(route, "release/v1", "src/a b.ts").href).toBe(
      "https://cnb.cool/acme/platform/web/-/blob/release%2Fv1/src/a%20b.ts",
    );
  });

  it("reserves the dash marker only in repository segments", () => {
    const route = {
      platform: "cnb", view: "root", repository: "acme/repo", ref: null, path: null,
    } as const;
    expect(buildCnbFileUrl(route, "release/-/v1", "src/-/a.ts").href).toBe(
      "https://cnb.cool/acme/repo/-/blob/release%2F-%2Fv1/src/-/a.ts",
    );
  });

  it("rejects unsafe repository, ref, and path inputs", () => {
    const validRoute = {
      platform: "cnb",
      view: "root",
      repository: "acme/platform/web",
      ref: null,
      path: null,
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
      expect(() => buildCnbFileUrl({ ...validRoute, repository: repo }, "main", "src/a.ts"))
        .toThrow(TypeError);
    }
    for (const ref of invalidRefs) {
      expect(() => buildCnbFileUrl(validRoute, ref, "src/a.ts")).toThrow(TypeError);
    }
    for (const path of invalidPaths) {
      expect(() => buildCnbFileUrl(validRoute, "main", path)).toThrow(TypeError);
    }
  });
});

describe("reconcileCnbRoute", () => {
  it("uses the longest discovered CNB ref", () => {
    const refs = [{ kind: "branch" as const, name: "release/v1", sha: "synthetic" }];
    expect(reconcileCnbRoute(
      new URL("https://cnb.cool/acme/repo/-/blob/release/v1/src/a.ts"), refs, "main",
    )).toMatchObject({ ref: "release/v1", path: "src/a.ts" });
  });
});

describe("cnbAdapter", () => {
  it("binds the exact CNB origin and route/provider/layout contracts", () => {
    expect(cnbAdapter).toMatchObject({ id: "cnb", origin: "https://cnb.cool" });
    expect(cnbAdapter.layout.platform).toBe("cnb");
    expect(cnbAdapter.parseRoute).toBe(parseCnbRoute);
    expect(cnbAdapter.reconcileRoute).toBe(reconcileCnbRoute);
    expect(cnbAdapter.buildFileUrl).toBe(buildCnbFileUrl);
    expect(cnbAdapter.buildRefRootUrl).toBe(buildCnbRefRootUrl);
  });

  it("builds a canonical encoded CNB ref root URL", () => {
    const route = {
      platform: "cnb", view: "root", repository: "acme/platform/web", ref: null, path: null,
    } as const;
    expect(buildCnbRefRootUrl(route, "release/v1").href).toBe(
      "https://cnb.cool/acme/platform/web/-/blob/release%2Fv1",
    );
  });
});
