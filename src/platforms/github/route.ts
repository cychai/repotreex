import type { RefOption } from "../../content/provider";
import { decodePathSegments, encodePathSegments } from "../../shared/path";
import type {
  PlatformRoute, RepositoryRoute, RouteHints, UnsupportedRoute,
} from "../types";

const githubOrigin = "https://github.com";
const unsupportedGitHubSections = new Set([
  "issues", "pulls", "actions", "projects", "wiki", "security", "pulse", "graphs",
  "settings", "releases", "commits", "branches", "tags", "network", "stargazers",
  "watchers", "forks", "insights",
]);

function unsupported(): UnsupportedRoute {
  return Object.freeze({ kind: "unsupported" });
}

function encodedPathSegments(pathname: string): string[] | null {
  // URL construction removes directly encoded dot segments before this raw-path boundary.
  // Reject surviving encoded forms here; pre-normalization checks require a separate raw-string API.
  const segments = pathname.split("/").slice(1);
  if (segments.at(-1) === "") segments.pop();
  return segments.some((segment) => segment.length === 0) ? null : segments;
}

function isEncodedDotSegment(segment: string): boolean {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded === "." || decoded === "..";
  } catch {
    return false;
  }
}

function decodeGitHubSegments(encoded: readonly string[]): string[] | null {
  const decoded = decodePathSegments(encoded);
  if (decoded === null || decoded.some(isEncodedDotSegment)) return null;
  return decoded;
}

function semanticSegments(value: string, minimum: number, label: string): string[] {
  const segments = value.split("/");
  if (segments.length < minimum) throw new TypeError(`Invalid ${label}`);
  try {
    encodePathSegments(segments);
  } catch {
    throw new TypeError(`Invalid ${label}`);
  }
  return segments;
}

function matchingKnownRef(
  routeSegments: readonly string[],
  knownRef: string | null | undefined,
): string[] | null {
  if (knownRef === null || knownRef === undefined) return null;

  let knownRefSegments: string[];
  try {
    knownRefSegments = semanticSegments(knownRef, 1, "ref");
  } catch {
    return null;
  }
  return knownRefSegments.length <= routeSegments.length &&
    knownRefSegments.every((segment, index) => routeSegments[index] === segment)
    ? knownRefSegments
    : null;
}

export function parseGitHubRoute(url: URL, hints: RouteHints = {}): PlatformRoute {
  if (url.origin !== githubOrigin || url.username !== "" || url.password !== "") {
    return unsupported();
  }

  const encodedSegments = encodedPathSegments(url.pathname);
  if (encodedSegments === null || encodedSegments.length < 2) return unsupported();

  const repositorySegments = decodeGitHubSegments(encodedSegments.slice(0, 2));
  if (repositorySegments === null) return unsupported();
  const repository = repositorySegments.join("/");

  if (encodedSegments.length === 2) {
    return { platform: "github", view: "root", repository, ref: null, path: null };
  }

  const routeKind = decodeGitHubSegments(encodedSegments.slice(2, 3))?.[0];
  if (routeKind === undefined || unsupportedGitHubSections.has(routeKind) ||
    (routeKind !== "tree" && routeKind !== "blob")) return unsupported();

  const routeSegments = decodeGitHubSegments(encodedSegments.slice(3));
  if (routeSegments === null || routeSegments.length === 0) return unsupported();

  const knownRefSegments = matchingKnownRef(routeSegments, hints.knownRef);
  const refSegments = knownRefSegments ?? routeSegments.slice(0, 1);
  const pathSegments = routeSegments.slice(refSegments.length);
  return {
    platform: "github",
    view: routeKind,
    repository,
    ref: refSegments.join("/"),
    path: pathSegments.join("/") || null,
  };
}

export function reconcileGitHubRoute(
  url: URL,
  refs: readonly RefOption[],
  head: string,
): PlatformRoute {
  const names = [...new Set([head, ...refs.map(({ name }) => name)])]
    .sort((left, right) => right.split("/").length - left.split("/").length ||
      right.length - left.length);
  for (const knownRef of names) {
    const candidate = parseGitHubRoute(url, { knownRef });
    if ("platform" in candidate && candidate.ref === knownRef) return candidate;
  }
  return parseGitHubRoute(url);
}

function encodedRepository(route: RepositoryRoute): string {
  if (route.platform !== "github") throw new TypeError("Invalid platform");
  const segments = semanticSegments(route.repository, 2, "repository");
  if (segments.length !== 2) throw new TypeError("Invalid repository");
  return encodePathSegments(segments);
}

function encodedValue(value: string, label: string): string {
  return encodePathSegments(semanticSegments(value, 1, label));
}

export function buildGitHubFileUrl(route: RepositoryRoute, ref: string, path: string): URL {
  return new URL(
    `/${encodedRepository(route)}/blob/${encodedValue(ref, "ref")}/${encodedValue(path, "path")}`,
    githubOrigin,
  );
}

export function buildGitHubRefRootUrl(route: RepositoryRoute, ref: string): URL {
  return new URL(
    `/${encodedRepository(route)}/tree/${encodedValue(ref, "ref")}`,
    githubOrigin,
  );
}
