export type PageKind = "repository" | "blob" | "commit";
export type UnsupportedRoute = { kind: "unsupported" };
export type RepositoryRoute = {
  kind: PageKind;
  repo: string;
  ref: string | null;
  filePath: string | null;
};
export type CnbRoute = RepositoryRoute | UnsupportedRoute;
export type RouteHints = { knownRef?: string | null };

const unsupportedRoute: UnsupportedRoute = { kind: "unsupported" };
const nonRepositoryRoutes = new Set([
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
]);

function decodeSegments(pathname: string): string[] | null {
  try {
    const encodedSegments = pathname.split("/").slice(1);
    if (encodedSegments.at(-1) === "") {
      encodedSegments.pop();
    }
    if (encodedSegments.some((segment) => segment.length === 0)) {
      return null;
    }
    const decodedSegments = encodedSegments.map((segment) => decodeURIComponent(segment));
    return decodedSegments.some((segment) => segment.length === 0 || segment.includes("/"))
      ? null
      : decodedSegments;
  } catch {
    return null;
  }
}

export function parseCnbRoute(url: URL, hints: RouteHints = {}): CnbRoute {
  if (url.protocol !== "https:" || url.hostname !== "cnb.cool") {
    return unsupportedRoute;
  }

  const segments = decodeSegments(url.pathname);
  if (segments === null || segments.length < 2 || nonRepositoryRoutes.has(segments[0])) {
    return unsupportedRoute;
  }

  const markerIndex = segments.indexOf("-");
  const repoSegments = markerIndex === -1 ? segments : segments.slice(0, markerIndex);
  if (repoSegments.length < 2) {
    return unsupportedRoute;
  }

  const repo = repoSegments.join("/");
  if (markerIndex === -1) {
    return { kind: "repository", repo, ref: null, filePath: null };
  }

  const [routeKind, ...routeSegments] = segments.slice(markerIndex + 1);
  if (routeKind === "commit" && routeSegments.length === 1 && routeSegments[0].length > 0) {
    return { kind: "commit", repo, ref: null, filePath: null };
  }

  const provisionalRef = routeSegments[0];
  if (routeKind !== "blob" || provisionalRef === undefined) {
    return unsupportedRoute;
  }

  const knownRefSegments = hints.knownRef?.split("/") ?? [];
  const matchesKnownRef =
    knownRefSegments.every((segment) => segment.length > 0) &&
    knownRefSegments.length > 0 &&
    knownRefSegments.every((segment, index) => routeSegments[index] === segment);
  const ref = matchesKnownRef ? (hints.knownRef ?? provisionalRef) : provisionalRef;
  const fileSegments = routeSegments.slice(matchesKnownRef ? knownRefSegments.length : 1);
  return {
    kind: "blob",
    repo,
    ref,
    filePath: fileSegments.length > 0 ? fileSegments.join("/") : null,
  };
}

export function buildBlobUrl(route: RepositoryRoute, ref: string, path: string): URL {
  const encodePath = (value: string): string => value.split("/").map(encodeURIComponent).join("/");
  const filePath = path.length > 0 ? `/${encodePath(path)}` : "";
  return new URL(
    `/${encodePath(route.repo)}/-/blob/${encodeURIComponent(ref)}${filePath}`,
    "https://cnb.cool",
  );
}
