import { describe, expect, it } from "vitest";
import { buildAllowedRequest } from "../src/page/allowlist";
import { classifyHttpError, RepositoryError } from "../src/shared/errors";

describe("buildAllowedRequest", () => {
  it("builds encoded content URLs", () => {
    expect(
      buildAllowedRequest({
        type: "list-directory",
        repo: "acme/platform/web",
        ref: "release/v1",
        path: "src/a b",
      }).href,
    ).toBe("https://cnb.cool/acme/platform/web/-/git/contents/src/a%20b?ref=release%2Fv1");
  });

  it("builds the root content URL without a trailing content path", () => {
    expect(
      buildAllowedRequest({
        type: "list-directory",
        repo: "acme/platform/web",
        ref: "main",
        path: "",
      }).href,
    ).toBe("https://cnb.cool/acme/platform/web/-/git/contents?ref=main");
  });

  it("builds only the fixed head, branch, and tag endpoint shapes", () => {
    expect(buildAllowedRequest({ type: "get-head", repo: "acme/platform/web" }).href).toBe(
      "https://cnb.cool/acme/platform/web/-/git/head",
    );
    expect(
      buildAllowedRequest({
        type: "list-branches",
        repo: "acme/platform/web",
        page: 2,
        pageSize: 50,
      }).href,
    ).toBe("https://cnb.cool/acme/platform/web/-/git/branches?page=2&page_size=50");
    expect(
      buildAllowedRequest({
        type: "list-tags",
        repo: "acme/platform/web",
        page: 3,
        pageSize: 25,
      }).href,
    ).toBe("https://cnb.cool/acme/platform/web/-/git/tags?page=3&page_size=25");
  });

  it("clamps pagination to positive integer request bounds", () => {
    expect(
      buildAllowedRequest({
        type: "list-branches",
        repo: "acme/repo",
        page: -10,
        pageSize: 1000,
      }).href,
    ).toBe("https://cnb.cool/acme/repo/-/git/branches?page=1&page_size=100");
    expect(
      buildAllowedRequest({
        type: "list-tags",
        repo: "acme/repo",
        page: 2.9,
        pageSize: 0.9,
      }).href,
    ).toBe("https://cnb.cool/acme/repo/-/git/tags?page=2&page_size=1");
  });

  it.each([
    "../profile",
    "/absolute",
    "acme/repo?admin=true",
    "acme/repo#fragment",
    "acme\\repo",
    "acme//repo",
    "acme/./repo",
    "acme/../repo",
    "acme/-/repo",
    "acme/repo\nnext",
    "acme/repo\u0085next",
    "acme/repo\u009fnext",
  ])("rejects unsafe repository input %s", (repo) => {
    expect(() => buildAllowedRequest({ type: "get-head", repo })).toThrow(TypeError);
  });

  it.each([
    "/src",
    "src/",
    "src//file",
    ".",
    "..",
    "src/../file",
    "src?raw=1",
    "src#part",
    "src/next\u0085file",
    "src/next\u009ffile",
  ])(
    "rejects unsafe content path input %s",
    (path) => {
      expect(() =>
        buildAllowedRequest({ type: "list-directory", repo: "acme/repo", ref: "main", path }),
      ).toThrow(TypeError);
    },
  );

  it.each([
    "",
    "/main",
    "main/",
    "main//next",
    ".",
    "..",
    "main/../next",
    "main?x=1",
    "release\u0085next",
    "release\u009fnext",
  ])(
    "rejects unsafe ref input %s",
    (ref) => {
      expect(() =>
        buildAllowedRequest({ type: "list-directory", repo: "acme/repo", ref, path: "" }),
      ).toThrow(TypeError);
    },
  );

  it.each([
    { page: Number.NaN, pageSize: 20 },
    { page: Number.POSITIVE_INFINITY, pageSize: 20 },
    { page: 1, pageSize: Number.NaN },
    { page: 1, pageSize: Number.POSITIVE_INFINITY },
  ])("rejects non-finite pagination input %#", ({ page, pageSize }) => {
    expect(() =>
      buildAllowedRequest({ type: "list-branches", repo: "acme/repo", page, pageSize }),
    ).toThrow(TypeError);
  });

  it("does not expose a generic URL or method operation", () => {
    expect(() =>
      buildAllowedRequest({
        type: "fetch",
        url: "https://example.com",
        method: "POST",
      } as never),
    ).toThrow(TypeError);
  });
});

describe("repository errors", () => {
  it.each([
    [401, "signed-out"],
    [403, "forbidden"],
    [404, "not-found"],
    [429, "rate-limited"],
    [500, "server"],
    [503, "server"],
    [400, "compatibility"],
  ] as const)("classifies HTTP %i as %s without response data", (status, code) => {
    const error = classifyHttpError(status);

    expect(error).toBeInstanceOf(RepositoryError);
    expect(error).toMatchObject({ code, status });
    expect(Object.keys(error).sort()).toEqual(["code", "status"]);
  });

  it("stores only the explicit retry metadata", () => {
    const error = new RepositoryError("rate-limited", { status: 429, retryAfter: 30 });

    expect(error).toMatchObject({ code: "rate-limited", status: 429, retryAfter: 30 });
    expect(Object.keys(error).sort()).toEqual(["code", "retryAfter", "status"]);
  });
});
