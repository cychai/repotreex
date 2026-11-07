import type { BridgeOperation } from "../shared/protocol";

const cnbOrigin = "https://cnb.cool";

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });
}

function validateSegments(
  value: string,
  label: string,
  options: { minimum: number; allowEmpty?: boolean; rejectMarker?: boolean },
): string[] {
  if (options.allowEmpty && value === "") {
    return [];
  }

  const segments = value.split("/");
  if (
    value.startsWith("/") ||
    segments.length < options.minimum ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\") ||
    hasControlCharacter(value) ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        (options.rejectMarker && segment === "-"),
    )
  ) {
    throw new TypeError(`Invalid ${label}`);
  }
  return segments;
}

function encodePath(segments: string[]): string {
  return segments.map(encodeURIComponent).join("/");
}

function repositoryUrl(repo: string): URL {
  const segments = validateSegments(repo, "repository", { minimum: 2, rejectMarker: true });
  const url = new URL(cnbOrigin);
  url.pathname = `/${encodePath(segments)}`;
  return url;
}

function clampInteger(value: number, minimum: number, maximum?: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError("Invalid pagination");
  }
  const integer = Math.trunc(value);
  return Math.min(Math.max(integer, minimum), maximum ?? Number.MAX_SAFE_INTEGER);
}

function paginatedRequest(operation: Extract<BridgeOperation, { page: number }>): URL {
  const url = repositoryUrl(operation.repo);
  url.pathname += operation.type === "list-branches" ? "/-/git/branches" : "/-/git/tags";
  url.search = new URLSearchParams({
    page: String(clampInteger(operation.page, 1)),
    page_size: String(clampInteger(operation.pageSize, 1, 100)),
  }).toString();
  return url;
}

export function buildAllowedRequest(operation: BridgeOperation): URL {
  switch (operation.type) {
    case "list-directory": {
      const url = repositoryUrl(operation.repo);
      const path = validateSegments(operation.path, "path", { minimum: 1, allowEmpty: true });
      validateSegments(operation.ref, "ref", { minimum: 1 });
      url.pathname += `/-/git/contents${path.length === 0 ? "" : `/${encodePath(path)}`}`;
      url.search = new URLSearchParams({ ref: operation.ref }).toString();
      return url;
    }
    case "get-head": {
      const url = repositoryUrl(operation.repo);
      url.pathname += "/-/git/head";
      return url;
    }
    case "list-branches":
    case "list-tags":
      return paginatedRequest(operation);
    default:
      throw new TypeError("Unsupported bridge operation");
  }
}
