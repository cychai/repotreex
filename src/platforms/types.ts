import type { BridgeClient } from "../content/bridge-client";
import type { RepositoryProvider, RefOption } from "../content/provider";

export type PlatformId = "cnb" | "github";
export type RepositoryView = "root" | "tree" | "blob";
export type UnsupportedRoute = Readonly<{ kind: "unsupported" }>;
export type RepositoryRoute = Readonly<{
  platform: PlatformId;
  view: RepositoryView;
  repository: string;
  ref: string | null;
  path: string | null;
}>;
export type PlatformRoute = RepositoryRoute | UnsupportedRoute;
export type RouteHints = Readonly<{ knownRef?: string | null }>;

export interface HostLayoutAdapter {
  readonly platform: PlatformId;
  install(document: Document, panelWidth: () => number): { update(open: boolean, overlay: boolean): void; destroy(): void };
}

export interface RepositoryPlatformAdapter {
  readonly id: PlatformId;
  readonly origin: `https://${string}`;
  readonly layout: HostLayoutAdapter;
  parseRoute(url: URL, hints?: RouteHints): PlatformRoute;
  reconcileRoute(url: URL, refs: readonly RefOption[], head: string): PlatformRoute;
  buildFileUrl(route: RepositoryRoute, ref: string, path: string): URL;
  buildRefRootUrl(route: RepositoryRoute, ref: string): URL;
  createProvider(client: BridgeClient): RepositoryProvider;
}
