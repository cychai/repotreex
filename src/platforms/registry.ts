import { cnbAdapter } from "./cnb";
import { githubAdapter } from "./github";
import type { RepositoryPlatformAdapter } from "./types";

const adapters = new Map<string, RepositoryPlatformAdapter>([
  [cnbAdapter.origin, cnbAdapter],
  [githubAdapter.origin, githubAdapter],
]);

export function repositoryPlatformForUrl(url: URL): RepositoryPlatformAdapter | null {
  return adapters.get(url.origin) ?? null;
}
