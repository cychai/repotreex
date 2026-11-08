import type { RefOption } from "../content/provider";
import {
  buildCnbFileUrl, buildCnbRefRootUrl, parseCnbRoute as adapterParseCnbRoute,
  reconcileCnbRoute as adapterReconcileCnbRoute,
} from "../platforms/cnb/route";
import type {
  PlatformRoute, RepositoryRoute as PlatformRepositoryRoute, RouteHints,
} from "../platforms/types";

export type PageKind = "repository" | "blob" | "commit";
export type UnsupportedRoute = Readonly<{ kind: "unsupported" }>;
export type RepositoryRoute = {
  kind: PageKind;
  repo: string;
  ref: string | null;
  filePath: string | null;
};
export type CnbRoute = RepositoryRoute | UnsupportedRoute;
export type { RouteHints };

function legacyRoute(route: PlatformRoute, url: URL): CnbRoute {
  if (!("platform" in route)) return route;
  const kind = route.view === "blob"
    ? "blob"
    : url.pathname.includes("/-/commit/") ? "commit" : "repository";
  return { kind, repo: route.repository, ref: route.ref, filePath: route.path };
}

function platformRoute(route: RepositoryRoute): PlatformRepositoryRoute {
  return {
    platform: "cnb",
    view: route.kind === "blob" ? "blob" : "root",
    repository: route.repo,
    ref: route.ref,
    path: route.filePath,
  };
}

export function parseCnbRoute(url: URL, hints: RouteHints = {}): CnbRoute {
  return legacyRoute(adapterParseCnbRoute(url, hints), url);
}

export function reconcileRepositoryRoute(
  url: URL,
  refs: readonly RefOption[],
  head: string,
): CnbRoute {
  return legacyRoute(adapterReconcileCnbRoute(url, refs, head), url);
}

export function buildBlobUrl(route: RepositoryRoute, ref: string, path: string): URL {
  return buildCnbFileUrl(platformRoute(route), ref, path);
}

export function buildRefRootUrl(route: RepositoryRoute, ref: string): URL {
  return buildCnbRefRootUrl(platformRoute(route), ref);
}

export {
  adapterReconcileCnbRoute as reconcileCnbRoute, buildCnbFileUrl, buildCnbRefRootUrl,
};
