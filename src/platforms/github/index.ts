import type { HostLayoutAdapter, RepositoryPlatformAdapter } from "../types";
import { createGitHubProvider } from "./provider";
import {
  buildGitHubFileUrl,
  buildGitHubRefRootUrl,
  parseGitHubRoute,
  reconcileGitHubRoute,
} from "./route";

const githubLayout: HostLayoutAdapter = {
  platform: "github",
  install() {
    return { update() {}, destroy() {} };
  },
};

export const githubAdapter: RepositoryPlatformAdapter = {
  id: "github",
  origin: "https://github.com",
  layout: githubLayout,
  parseRoute: parseGitHubRoute,
  reconcileRoute: reconcileGitHubRoute,
  buildFileUrl: buildGitHubFileUrl,
  buildRefRootUrl: buildGitHubRefRootUrl,
  createProvider: createGitHubProvider,
};
