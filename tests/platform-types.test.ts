import { describe, expect, expectTypeOf, it } from "vitest";
import {
  decodePathSegments, encodePathSegments, validatePathSegments,
  type SegmentValidationOptions,
} from "../src/shared/path";
import type { PlatformId, RepositoryPlatformAdapter, RepositoryRoute } from "../src/platforms/types";

describe("shared platform contracts", () => {
  it("keeps platform identity on every repository route", () => {
    const route: RepositoryRoute = {
      platform: "github", view: "blob", repository: "acme/repo", ref: "release/v1", path: "src/a b.ts",
    };
    expect(route.platform satisfies PlatformId).toBe("github");
    expectTypeOf<RepositoryPlatformAdapter["parseRoute"]>().toBeFunction();
  });

  it("decodes and re-encodes only safe individual path segments", () => {
    expect(decodePathSegments(["src", "a%20b.ts"])).toEqual(["src", "a b.ts"]);
    expect(decodePathSegments(["src%2Fa.ts"])).toBeNull();
    expect(encodePathSegments(["release", "v1"])).toBe("release/v1");
  });

  it.each(["", ".", "..", "a/b", "a\\b", "a\u0000b", "a\u0085b", "a\u009fb"])(
    "rejects the unsafe decoded segment %s", (segment) => {
      expect(decodePathSegments([encodeURIComponent(segment)])).toBeNull();
      expect(() => encodePathSegments([segment])).toThrow(TypeError);
    },
  );

  it("rejects malformed percent encoding and configured marker values", () => {
    expect(decodePathSegments(["repo%ZZ"])).toBeNull();
    const options: SegmentValidationOptions = {
      label: "repository", minimum: 2, markers: ["-"],
    };
    expect(() => validatePathSegments("acme/-/repo", options)).toThrow(TypeError);
  });

  it.each(["", "/main", "main/", "main//next", ".", "..", "main/../next", "main\\next", "main\nnext"])(
    "rejects unsafe segmented values %s", (value) => {
      expect(() => validatePathSegments(value, { label: "ref", minimum: 1 })).toThrow(TypeError);
    },
  );
});
