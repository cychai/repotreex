import { describe, expect, it } from "vitest";
import { buildAllowedRequest } from "../src/page/allowlist";
import { buildCnbAllowedRequest } from "../src/platforms/cnb/requests";
import { buildGitHubAllowedRequest } from "../src/platforms/github/requests";
import { classifyHttpError, RepositoryError } from "../src/shared/errors";

describe("buildAllowedRequest", () => {
  it("builds isolated CNB and GitHub request shapes", () => {
    expect(buildAllowedRequest({
      platform: "cnb", type: "get-head", repository: "acme/repo",
    })).toEqual({
      url: new URL("https://cnb.cool/acme/repo/-/git/head"),
      accept: "json",
      maximumBodyUnits: 2_000_000,
    });
    expect(buildAllowedRequest({
      platform: "github", type: "repository-page", repository: "acme/repo",
      ref: "main", path: "src", view: "tree",
    })).toEqual({
      url: new URL("https://github.com/acme/repo/tree/main/src"),
      accept: "html",
      maximumBodyUnits: 2_000_000,
    });
  });

  it("builds encoded content URLs", () => {
    expect(
      buildAllowedRequest({
        platform: "cnb",
        type: "list-directory",
        repository: "acme/platform/web",
        ref: "release/v1",
        path: "src/a b",
      }).url.href,
    ).toBe("https://cnb.cool/acme/platform/web/-/git/contents/src/a%20b?ref=release%2Fv1");
  });

  it("builds the root content URL without a trailing content path", () => {
    expect(
      buildAllowedRequest({
        platform: "cnb",
        type: "list-directory",
        repository: "acme/platform/web",
        ref: "main",
        path: "",
      }).url.href,
    ).toBe("https://cnb.cool/acme/platform/web/-/git/contents?ref=main");
  });

  it("builds only the fixed head, branch, and tag endpoint shapes", () => {
    expect(buildAllowedRequest({ platform: "cnb", type: "get-head", repository: "acme/platform/web" }).url.href).toBe(
      "https://cnb.cool/acme/platform/web/-/git/head",
    );
    expect(
      buildAllowedRequest({
        platform: "cnb",
        type: "list-branches",
        repository: "acme/platform/web",
        page: 2,
        pageSize: 50,
      }).url.href,
    ).toBe("https://cnb.cool/acme/platform/web/-/git/branches?page=2&page_size=50");
    expect(
      buildAllowedRequest({
        platform: "cnb",
        type: "list-tags",
        repository: "acme/platform/web",
        page: 3,
        pageSize: 25,
      }).url.href,
    ).toBe("https://cnb.cool/acme/platform/web/-/git/tags?page=3&page_size=25");
  });

  it("builds only the fixed GitHub repository and observed refs page shapes", () => {
    expect(buildAllowedRequest({
      platform: "github", type: "repository-page", repository: "acme/repo",
      ref: null, path: "", view: "root",
    }).url.href).toBe("https://github.com/acme/repo");
    expect(buildAllowedRequest({
      platform: "github", type: "repository-page", repository: "acme/repo",
      ref: "release/v1", path: "src/a b", view: "tree",
    }).url.href).toBe("https://github.com/acme/repo/tree/release/v1/src/a%20b");
    expect(buildAllowedRequest({
      platform: "github", type: "repository-page", repository: "acme/repo",
      ref: "main", path: "README.md", view: "blob",
    }).url.href).toBe("https://github.com/acme/repo/blob/main/README.md");
    expect(buildAllowedRequest({
      platform: "github", type: "repository-page", repository: "acme/repo",
      ref: "release%2Fv1", path: "src/100%.ts", view: "blob",
    }).url.href).toBe("https://github.com/acme/repo/blob/release%252Fv1/src/100%25.ts");
    expect(buildAllowedRequest({
      platform: "github", type: "refs-page", repository: "acme/repo", kind: "branches", page: 2,
    }).url.href).toBe("https://github.com/acme/repo/branches/all?page=2");
    expect(buildAllowedRequest({
      platform: "github", type: "refs-page", repository: "acme/repo", kind: "tags", after: null,
    }).url.href).toBe("https://github.com/acme/repo/tags");
    expect(buildAllowedRequest({
      platform: "github", type: "refs-page", repository: "acme/repo", kind: "tags", after: "release/v1",
    }).url.href).toBe("https://github.com/acme/repo/tags?after=release%2Fv1");
  });

  it("clamps pagination to positive integer request bounds", () => {
    expect(
      buildAllowedRequest({
        platform: "cnb",
        type: "list-branches",
        repository: "acme/repo",
        page: -10,
        pageSize: 1000,
      }).url.href,
    ).toBe("https://cnb.cool/acme/repo/-/git/branches?page=1&page_size=100");
    expect(
      buildAllowedRequest({
        platform: "cnb",
        type: "list-tags",
        repository: "acme/repo",
        page: 2.9,
        pageSize: 0.9,
      }).url.href,
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
  ])("rejects unsafe repository input %s", (repository) => {
    expect(() => buildAllowedRequest({ platform: "cnb", type: "get-head", repository })).toThrow(TypeError);
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
        buildAllowedRequest({
          platform: "cnb", type: "list-directory", repository: "acme/repo", ref: "main", path,
        }),
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
        buildAllowedRequest({
          platform: "cnb", type: "list-directory", repository: "acme/repo", ref, path: "",
        }),
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
      buildAllowedRequest({
        platform: "cnb", type: "list-branches", repository: "acme/repo", page, pageSize,
      }),
    ).toThrow(TypeError);
  });

  it("rejects cross-platform and arbitrary request confusion", () => {
    expect(() => buildAllowedRequest({
      platform: "github", type: "get-head", repository: "acme/repo",
    } as never)).toThrow(TypeError);
    expect(() =>
      buildAllowedRequest({
        platform: "github",
        type: "fetch",
        url: "https://evil.example",
        method: "POST",
      } as never),
    ).toThrow(TypeError);
  });

  it.each([
    { platform: "cnb", type: "get-head", repository: "acme/repo", url: "https://evil.example" },
    { platform: "cnb", type: "get-head", repository: "acme/repo", method: "POST" },
    { platform: "cnb", type: "get-head", repository: "acme/repo", headers: {} },
    { platform: "cnb", type: "get-head", repository: "acme/repo", credentials: "omit" },
    { platform: "cnb", type: "get-head", repository: "acme/repo", redirect: "manual" },
    { platform: "cnb", type: "get-head", repository: "acme/repo", maximumBodyUnits: 1 },
    { platform: "github", type: "refs-page", repository: "acme/repo", kind: "tags", after: "" },
    { platform: "github", type: "refs-page", repository: "acme/repo", kind: "tags", after: 3 },
    { platform: "github", type: "refs-page", repository: "acme/repo", kind: "tags", page: 1 },
    { platform: "github", type: "refs-page", repository: "acme/repo", kind: "releases", page: 1 },
    { platform: "github", type: "repository-page", repository: "acme/repo", ref: null, path: "src", view: "root" },
    { platform: "github", type: "repository-page", repository: "acme/repo", ref: null, path: "", view: "tree" },
  ])("rejects non-exact or invalid operation %#", (operation) => {
    expect(() => buildAllowedRequest(operation as never)).toThrow(TypeError);
  });

  it("rejects inherited and accessor-backed operation fields without reading them", () => {
    expect(() => buildAllowedRequest(Object.create({
      platform: "cnb", type: "get-head", repository: "acme/repo",
    }) as never)).toThrow(TypeError);
    let reads = 0;
    const operation = Object.defineProperty({
      platform: "cnb", type: "get-head",
    }, "repository", {
      enumerable: true,
      get() { reads++; return "acme/repo"; },
    });
    expect(() => buildAllowedRequest(operation as never)).toThrow(TypeError);
    expect(reads).toBe(0);
  });

  it("rejects proxy-backed operations without exposing proxy failures", () => {
    const descriptorProxy = new Proxy({}, {
      getOwnPropertyDescriptor() { throw new Error("private proxy failure"); },
    });
    expect(() => buildAllowedRequest(descriptorProxy as never)).toThrow(TypeError);
    const ownKeysProxy = new Proxy({
      platform: "cnb", type: "get-head", repository: "acme/repo",
    }, {
      ownKeys() { throw new Error("private proxy failure"); },
    });
    expect(() => buildAllowedRequest(ownKeysProxy as never)).toThrow(TypeError);
    const hasProxy = new Proxy({
      platform: "cnb", type: "get-head", repository: "acme/repo",
    }, {
      has() { throw new Error("private proxy failure"); },
    });
    expect(() => buildAllowedRequest(hasProxy as never)).toThrow(TypeError);
  });

  it("rejects every non-enumerable and symbol own operation key", () => {
    const hidden = Object.defineProperty({
      platform: "cnb", type: "get-head", repository: "acme/repo",
    }, "method", { value: "POST" });
    expect(() => buildAllowedRequest(hidden as never)).toThrow(TypeError);
    const symbol = Symbol("caller-control");
    const symbolOperation = {
      platform: "cnb", type: "get-head", repository: "acme/repo", [symbol]: "POST",
    };
    expect(() => buildAllowedRequest(symbolOperation as never)).toThrow(TypeError);
  });

  it.each(["method", "url", "origin", "headers", "credentials", "redirect", "maximumBodyUnits"])(
    "rejects inherited caller control %s without rejecting Object.prototype",
    (control) => {
      const operation = Object.assign(Object.create({ [control]: "hostile" }), {
        platform: "cnb", type: "get-head", repository: "acme/repo",
      });
      expect(() => buildAllowedRequest(operation as never)).toThrow(TypeError);
      expect(() => buildAllowedRequest({
        platform: "cnb", type: "get-head", repository: "acme/repo",
      })).not.toThrow();
    },
  );

  it("rejects inherited origin in both platform builders", () => {
    const cnbOperation = Object.assign(Object.create({ origin: "https://evil.example" }), {
      platform: "cnb" as const, type: "get-head" as const, repository: "acme/repo",
    });
    const githubOperation = Object.assign(Object.create({ origin: "https://evil.example" }), {
      platform: "github" as const, type: "refs-page" as const,
      repository: "acme/repo", kind: "tags" as const, after: null,
    });

    expect(() => buildCnbAllowedRequest(cnbOperation)).toThrow(TypeError);
    expect(() => buildGitHubAllowedRequest(githubOperation)).toThrow(TypeError);
  });

  it("normalizes revoked operation proxies at every request builder boundary", () => {
    const revokedCnb = Proxy.revocable({
      platform: "cnb" as const, type: "get-head" as const, repository: "acme/repo",
    }, {});
    const revokedGitHub = Proxy.revocable({
      platform: "github" as const, type: "refs-page" as const,
      repository: "acme/repo", kind: "tags" as const, after: null,
    }, {});
    revokedCnb.revoke();
    revokedGitHub.revoke();

    expect(() => buildAllowedRequest(revokedCnb.proxy)).toThrow("Invalid bridge operation");
    expect(() => buildCnbAllowedRequest(revokedCnb.proxy)).toThrow("Invalid CNB bridge operation");
    expect(() => buildGitHubAllowedRequest(revokedGitHub.proxy)).toThrow("Invalid GitHub bridge operation");
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
