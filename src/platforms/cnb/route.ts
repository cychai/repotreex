import type { RefOption } from "../../content/provider";
import {
  decodePathSegments, encodePathSegments, validatePathSegments,
} from "../../shared/path";
import type {
  PlatformRoute, RepositoryRoute, RouteHints, UnsupportedRoute,
} from "../types";

const cnbOrigin = "https://cnb.cool";
const nonRepositoryRoutes = new Set([
  "profile", "login", "oauth2", "explore", "new", "u", "search", "announcements",
  "invitations", "error", "forbidden", "freeze", "mine", "user-locked", "wx",
]);

function unsupported(): UnsupportedRoute {
  return Object.freeze({ kind: "unsupported" });
}

function encodedPathSegments(pathname: string): string[] | null {
  const segments = pathname.split("/").slice(1);
  if (segments.at(-1) === "") segments.pop();
  return segments.some((segment) => segment.length === 0) ? null : segments;
}

function decodeSegment(segment: string): string | null {
  return decodePathSegments([segment])?.[0] ?? null;
}

function hasValidBoundaries(value: string, allowSlash: boolean): boolean {
  if (!allowSlash && value.includes("/")) return false;
  try {
    validatePathSegments(value, { label: "route", minimum: 1 });
    return true;
  } catch {
    return false;
  }
}

function parseBlobRoute(
  repository: string,
  encodedRouteSegments: string[],
  knownRef: string | null | undefined,
): PlatformRoute {
  const encodedRef = encodedRouteSegments[0];
  if (encodedRef === undefined) return unsupported();

  let decodedRef: string;
  try {
    decodedRef = decodeURIComponent(encodedRef);
  } catch {
    return unsupported();
  }

  const containsEncodedBoundary = decodedRef.includes("/");
  if (!hasValidBoundaries(decodedRef, true) ||
    (containsEncodedBoundary && decodedRef !== knownRef)) return unsupported();

  const fileSegments = decodePathSegments(encodedRouteSegments.slice(1));
  if (fileSegments === null) return unsupported();

  if (containsEncodedBoundary || knownRef === decodedRef) {
    return { platform: "cnb", view: "blob", repository, ref: decodedRef,
      path: fileSegments.length > 0 ? fileSegments.join("/") : null };
  }

  const knownRefSegments = knownRef?.split("/") ?? [];
  const decodedRouteSegments = [decodedRef, ...fileSegments];
  const matchesKnownRef = knownRefSegments.length > 0 && hasValidBoundaries(knownRef ?? "", true) &&
    knownRefSegments.every((segment, index) => decodedRouteSegments[index] === segment);
  const ref = matchesKnownRef ? (knownRef ?? decodedRef) : decodedRef;
  const pathStart = matchesKnownRef ? knownRefSegments.length : 1;
  return { platform: "cnb", view: "blob", repository, ref,
    path: decodedRouteSegments.slice(pathStart).join("/") || null };
}

export function parseCnbRoute(url: URL, hints: RouteHints = {}): PlatformRoute {
  if (url.origin !== cnbOrigin || url.username !== "" || url.password !== "") return unsupported();

  const encodedSegments = encodedPathSegments(url.pathname);
  if (encodedSegments === null) return unsupported();

  const markerIndex = encodedSegments.indexOf("-");
  const encodedRepositorySegments = markerIndex === -1
    ? encodedSegments : encodedSegments.slice(0, markerIndex);
  const repositorySegments = decodePathSegments(encodedRepositorySegments);
  if (repositorySegments === null || repositorySegments.length < 2 ||
    nonRepositoryRoutes.has(repositorySegments[0])) return unsupported();

  const repository = repositorySegments.join("/");
  if (markerIndex === -1) {
    return { platform: "cnb", view: "root", repository, ref: null, path: null };
  }

  const routeKind = decodeSegment(encodedSegments[markerIndex + 1] ?? "");
  const encodedRouteSegments = encodedSegments.slice(markerIndex + 2);
  if (routeKind === "commit") {
    const commitSegments = decodePathSegments(encodedRouteSegments);
    return commitSegments?.length === 1
      ? { platform: "cnb", view: "root", repository, ref: null, path: null }
      : unsupported();
  }
  return routeKind === "blob"
    ? parseBlobRoute(repository, encodedRouteSegments, hints.knownRef)
    : unsupported();
}

export function reconcileCnbRoute(
  url: URL,
  refs: readonly RefOption[],
  head: string,
): PlatformRoute {
  const candidates = [...new Set([head, ...refs.map(({ name }) => name)])]
    .sort((left, right) => right.length - left.length);
  for (const knownRef of candidates) {
    const route = parseCnbRoute(url, { knownRef });
    if ("platform" in route && route.view === "blob" && route.ref === knownRef) {
      return route;
    }
  }
  return parseCnbRoute(url);
}

function encodedRepository(route: RepositoryRoute): string {
  if (route.platform !== "cnb") throw new TypeError("Invalid platform");
  const segments = validatePathSegments(route.repository, {
    label: "repository", minimum: 2, markers: ["-"],
  });
  return encodePathSegments(segments);
}

function encodedRef(ref: string): string {
  const segments = validatePathSegments(ref, { label: "ref", minimum: 1 });
  return encodeURIComponent(segments.join("/"));
}

export function buildCnbFileUrl(route: RepositoryRoute, ref: string, path: string): URL {
  const repository = encodedRepository(route);
  const reference = encodedRef(ref);
  const filePath = encodePathSegments(validatePathSegments(path, { label: "path", minimum: 1 }));
  return new URL(`/${repository}/-/blob/${reference}/${filePath}`, cnbOrigin);
}

export function buildCnbRefRootUrl(route: RepositoryRoute, ref: string): URL {
  return new URL(`/${encodedRepository(route)}/-/blob/${encodedRef(ref)}`, cnbOrigin);
}
