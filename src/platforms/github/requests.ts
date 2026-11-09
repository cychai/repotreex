import { FORBIDDEN_BRIDGE_CONTROLS, type GitHubBridgeOperation } from "../../shared/protocol";

const githubOrigin = "https://github.com";
const maximumBodyUnits = 2_000_000;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ownKeys = Reflect.ownKeys;

export type GitHubAllowedRequest = {
  url: URL;
  accept: "html";
  maximumBodyUnits: number;
};

function requireRecord(value: unknown): object {
  try {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
  } catch {
    throw new TypeError("Invalid GitHub bridge operation");
  }
  throw new TypeError("Invalid GitHub bridge operation");
}

function ownData(value: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = getOwnPropertyDescriptor(value, key);
  } catch {
    throw new TypeError("Invalid GitHub bridge operation");
  }
  if (!descriptor || !("value" in descriptor)) throw new TypeError("Invalid GitHub bridge operation");
  return descriptor.value;
}

function requireExactKeys(value: object, keys: readonly string[]): void {
  let actualKeys: (string | symbol)[];
  try {
    actualKeys = ownKeys(value);
  } catch {
    throw new TypeError("Invalid GitHub bridge operation");
  }
  if (actualKeys.length !== keys.length || !keys.every((key) => actualKeys.includes(key))) {
    throw new TypeError("Invalid GitHub bridge operation");
  }
  for (const control of FORBIDDEN_BRIDGE_CONTROLS) {
    try {
      if (control in value && !Object.hasOwn(value, control)) throw new TypeError("Invalid GitHub bridge operation");
    } catch {
      throw new TypeError("Invalid GitHub bridge operation");
    }
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function encodedSegments(value: unknown, label: string, minimum: number, allowEmpty = false): string {
  if (typeof value !== "string") throw new TypeError(`Invalid ${label}`);
  if (allowEmpty && value === "") return "";
  const segments = value.split("/");
  if (segments.length < minimum || segments.some((segment) =>
    segment.length === 0 || segment === "." || segment === ".." ||
    segment.includes("\\") || hasControlCharacter(segment))) {
    throw new TypeError(`Invalid ${label}`);
  }
  return segments.map(encodeURIComponent).join("/");
}

function repositoryUrl(repository: unknown): URL {
  const encoded = encodedSegments(repository, "repository", 2);
  if (encoded.split("/").length !== 2) throw new TypeError("Invalid repository");
  return new URL(`/${encoded}`, githubOrigin);
}

function requirePage(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("Invalid pagination");
  if (!Number.isInteger(value) || value < 1) throw new TypeError("Invalid pagination");
  return value;
}

function requireCursor(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || hasControlCharacter(value)) {
    throw new TypeError("Invalid pagination");
  }
  return value;
}

function allowed(url: URL): GitHubAllowedRequest {
  return { url, accept: "html", maximumBodyUnits };
}

export function buildGitHubAllowedRequest(
  operation: GitHubBridgeOperation,
): GitHubAllowedRequest {
  const record = requireRecord(operation);
  const platform = ownData(record, "platform");
  const type = ownData(record, "type");
  if (platform !== "github") throw new TypeError("Invalid GitHub bridge operation");

  switch (type) {
    case "repository-page": {
      requireExactKeys(record, ["platform", "type", "repository", "ref", "path", "view"]);
      const url = repositoryUrl(ownData(record, "repository"));
      const ref = ownData(record, "ref");
      const path = ownData(record, "path");
      const view = ownData(record, "view");
      if (view === "root") {
        if (ref !== null || path !== "") throw new TypeError("Invalid root repository page");
        return allowed(url);
      }
      if ((view !== "tree" && view !== "blob") || typeof ref !== "string") {
        throw new TypeError("Invalid repository page");
      }
      const encodedRef = encodedSegments(ref, "ref", 1);
      const encodedPath = encodedSegments(path, "path", 1, view === "tree");
      url.pathname += `/${view}/${encodedRef}${encodedPath === "" ? "" : `/${encodedPath}`}`;
      return allowed(url);
    }
    case "refs-page": {
      const url = repositoryUrl(ownData(record, "repository"));
      const kind = ownData(record, "kind");
      if (kind === "branches") {
        requireExactKeys(record, ["platform", "type", "repository", "kind", "page"]);
        url.pathname += "/branches/all";
        url.search = new URLSearchParams({ page: String(requirePage(ownData(record, "page"))) }).toString();
        return allowed(url);
      }
      if (kind !== "tags") throw new TypeError("Invalid refs kind");
      requireExactKeys(record, ["platform", "type", "repository", "kind", "after"]);
      url.pathname += "/tags";
      const after = requireCursor(ownData(record, "after"));
      if (after !== null) url.search = new URLSearchParams({ after }).toString();
      return allowed(url);
    }
    default:
      throw new TypeError("Unsupported GitHub bridge operation");
  }
}
