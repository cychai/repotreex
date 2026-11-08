import { FORBIDDEN_BRIDGE_CONTROLS, type CnbBridgeOperation } from "../../shared/protocol";

const cnbOrigin = "https://cnb.cool";
const maximumBodyUnits = 2_000_000;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ownKeys = Reflect.ownKeys;

export type CnbAllowedRequest = {
  url: URL;
  accept: "json";
  maximumBodyUnits: number;
};

function requireRecord(value: unknown): object {
  try {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
  } catch {
    throw new TypeError("Invalid CNB bridge operation");
  }
  throw new TypeError("Invalid CNB bridge operation");
}

function ownData(value: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = getOwnPropertyDescriptor(value, key);
  } catch {
    throw new TypeError("Invalid CNB bridge operation");
  }
  if (!descriptor || !("value" in descriptor)) throw new TypeError("Invalid CNB bridge operation");
  return descriptor.value;
}

function requireExactKeys(value: object, keys: readonly string[]): void {
  let actualKeys: (string | symbol)[];
  try {
    actualKeys = ownKeys(value);
  } catch {
    throw new TypeError("Invalid CNB bridge operation");
  }
  if (actualKeys.length !== keys.length || !keys.every((key) => actualKeys.includes(key))) {
    throw new TypeError("Invalid CNB bridge operation");
  }
  for (const control of FORBIDDEN_BRIDGE_CONTROLS) {
    try {
      if (control in value && !Object.hasOwn(value, control)) throw new TypeError("Invalid CNB bridge operation");
    } catch {
      throw new TypeError("Invalid CNB bridge operation");
    }
  }
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });
}

function validateSegments(
  value: unknown,
  label: string,
  options: { minimum: number; allowEmpty?: boolean; rejectMarker?: boolean },
): string[] {
  if (typeof value !== "string") throw new TypeError(`Invalid ${label}`);
  if (options.allowEmpty && value === "") return [];

  const segments = value.split("/");
  if (
    value.startsWith("/") ||
    segments.length < options.minimum ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\") ||
    hasControlCharacter(value) ||
    segments.some((segment) =>
      segment.length === 0 || segment === "." || segment === ".." ||
      (options.rejectMarker && segment === "-"))
  ) {
    throw new TypeError(`Invalid ${label}`);
  }
  return segments;
}

function encodePath(segments: readonly string[]): string {
  return segments.map(encodeURIComponent).join("/");
}

function repositoryUrl(repository: unknown): URL {
  const segments = validateSegments(repository, "repository", { minimum: 2, rejectMarker: true });
  const url = new URL(cnbOrigin);
  url.pathname = `/${encodePath(segments)}`;
  return url;
}

function clampInteger(value: unknown, minimum: number, maximum?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Invalid pagination");
  }
  const integer = Math.trunc(value);
  return Math.min(Math.max(integer, minimum), maximum ?? Number.MAX_SAFE_INTEGER);
}

function allowed(url: URL): CnbAllowedRequest {
  return { url, accept: "json", maximumBodyUnits };
}

export function buildCnbAllowedRequest(operation: CnbBridgeOperation): CnbAllowedRequest {
  const record = requireRecord(operation);
  const platform = ownData(record, "platform");
  const type = ownData(record, "type");
  if (platform !== "cnb") throw new TypeError("Invalid CNB bridge operation");

  switch (type) {
    case "list-directory": {
      requireExactKeys(record, ["platform", "type", "repository", "ref", "path"]);
      const url = repositoryUrl(ownData(record, "repository"));
      const path = validateSegments(ownData(record, "path"), "path", { minimum: 1, allowEmpty: true });
      const ref = ownData(record, "ref");
      validateSegments(ref, "ref", { minimum: 1 });
      url.pathname += `/-/git/contents${path.length === 0 ? "" : `/${encodePath(path)}`}`;
      url.search = new URLSearchParams({ ref: ref as string }).toString();
      return allowed(url);
    }
    case "get-head": {
      requireExactKeys(record, ["platform", "type", "repository"]);
      const url = repositoryUrl(ownData(record, "repository"));
      url.pathname += "/-/git/head";
      return allowed(url);
    }
    case "list-branches":
    case "list-tags": {
      requireExactKeys(record, ["platform", "type", "repository", "page", "pageSize"]);
      const url = repositoryUrl(ownData(record, "repository"));
      url.pathname += type === "list-branches" ? "/-/git/branches" : "/-/git/tags";
      url.search = new URLSearchParams({
        page: String(clampInteger(ownData(record, "page"), 1)),
        page_size: String(clampInteger(ownData(record, "pageSize"), 1, 100)),
      }).toString();
      return allowed(url);
    }
    default:
      throw new TypeError("Unsupported CNB bridge operation");
  }
}
