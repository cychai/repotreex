export type PageKind = "repository" | "blob" | "commit";
export type UnsupportedRoute = Readonly<{ kind: "unsupported" }>;
export type RepositoryRoute = {
  kind: PageKind;
  repo: string;
  ref: string | null;
  filePath: string | null;
};
export type CnbRoute = RepositoryRoute | UnsupportedRoute;
export type RouteHints = { knownRef?: string | null };

const cnbOrigin = "https://cnb.cool";
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

function unsupported(): UnsupportedRoute {
  return Object.freeze({ kind: "unsupported" });
}

function encodedPathSegments(pathname: string): string[] | null {
  const segments = pathname.split("/").slice(1);
  if (segments.at(-1) === "") {
    segments.pop();
  }
  return segments.some((segment) => segment.length === 0) ? null : segments;
}

function isSafeSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !Array.from(segment).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  );
}

function hasValidBoundaries(value: string, allowSlash: boolean): boolean {
  const segments = value.split("/");
  return (
    (allowSlash || segments.length === 1) &&
    segments.every((segment) => isSafeSegment(segment) && !segment.includes("\\"))
  );
}

function decodeSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    return isSafeSegment(decoded) && !decoded.includes("/") ? decoded : null;
  } catch {
    return null;
  }
}

function decodeSegments(segments: string[]): string[] | null {
  const decoded = segments.map(decodeSegment);
  return decoded.some((segment) => segment === null) ? null : (decoded as string[]);
}

function validatedSegments(value: string, minimum: number, label: string): string[] {
  const segments = value.split("/");
  if (
    segments.length < minimum ||
    segments.some((segment) => !isSafeSegment(segment) || segment.includes("\\"))
  ) {
    throw new TypeError(`Invalid ${label}`);
  }
  return segments;
}

function parseBlobRoute(
  repo: string,
  encodedRouteSegments: string[],
  knownRef: string | null | undefined,
): CnbRoute {
  const encodedRef = encodedRouteSegments[0];
  if (encodedRef === undefined) {
    return unsupported();
  }

  let decodedRef: string;
  try {
    decodedRef = decodeURIComponent(encodedRef);
  } catch {
    return unsupported();
  }

  const containsEncodedBoundary = decodedRef.includes("/");
  if (
    !hasValidBoundaries(decodedRef, true) ||
    (containsEncodedBoundary && decodedRef !== knownRef)
  ) {
    return unsupported();
  }

  const encodedFileSegments = encodedRouteSegments.slice(1);
  const fileSegments = decodeSegments(encodedFileSegments);
  if (fileSegments === null) {
    return unsupported();
  }

  if (containsEncodedBoundary || knownRef === decodedRef) {
    return {
      kind: "blob",
      repo,
      ref: decodedRef,
      filePath: fileSegments.length > 0 ? fileSegments.join("/") : null,
    };
  }

  const knownRefSegments = knownRef?.split("/") ?? [];
  const decodedRouteSegments = [decodedRef, ...fileSegments];
  const matchesKnownRef =
    knownRefSegments.length > 0 &&
    hasValidBoundaries(knownRef ?? "", true) &&
    knownRefSegments.every((segment, index) => decodedRouteSegments[index] === segment);
  const ref = matchesKnownRef ? (knownRef ?? decodedRef) : decodedRef;
  const pathStart = matchesKnownRef ? knownRefSegments.length : 1;
  return {
    kind: "blob",
    repo,
    ref,
    filePath: decodedRouteSegments.slice(pathStart).join("/") || null,
  };
}

export function parseCnbRoute(url: URL, hints: RouteHints = {}): CnbRoute {
  if (url.origin !== cnbOrigin || url.username !== "" || url.password !== "") {
    return unsupported();
  }

  const encodedSegments = encodedPathSegments(url.pathname);
  if (encodedSegments === null) {
    return unsupported();
  }

  const markerIndex = encodedSegments.indexOf("-");
  const encodedRepoSegments = markerIndex === -1 ? encodedSegments : encodedSegments.slice(0, markerIndex);
  const repoSegments = decodeSegments(encodedRepoSegments);
  if (
    repoSegments === null ||
    repoSegments.length < 2 ||
    nonRepositoryRoutes.has(repoSegments[0])
  ) {
    return unsupported();
  }

  const repo = repoSegments.join("/");
  if (markerIndex === -1) {
    return { kind: "repository", repo, ref: null, filePath: null };
  }

  const routeKind = decodeSegment(encodedSegments[markerIndex + 1] ?? "");
  const encodedRouteSegments = encodedSegments.slice(markerIndex + 2);
  if (routeKind === "commit") {
    const commitSegments = decodeSegments(encodedRouteSegments);
    return commitSegments?.length === 1
      ? { kind: "commit", repo, ref: null, filePath: null }
      : unsupported();
  }
  return routeKind === "blob"
    ? parseBlobRoute(repo, encodedRouteSegments, hints.knownRef)
    : unsupported();
}

export function buildBlobUrl(route: RepositoryRoute, ref: string, path: string): URL {
  const repoSegments = validatedSegments(route.repo, 2, "repository");
  const refSegments = validatedSegments(ref, 1, "ref");
  const pathSegments = validatedSegments(path, 1, "path");
  const repo = repoSegments.map(encodeURIComponent).join("/");
  const filePath = pathSegments.map(encodeURIComponent).join("/");
  return new URL(
    `/${repo}/-/blob/${encodeURIComponent(refSegments.join("/"))}/${filePath}`,
    cnbOrigin,
  );
}
