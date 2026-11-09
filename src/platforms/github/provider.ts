import type { BridgeClient } from "../../content/bridge-client";
import type { RefOption, RepositoryProvider } from "../../content/provider";
import { RepositoryError } from "../../shared/errors";
import type { GitHubBridgeOperation } from "../../shared/protocol";
import { decodeGitHubRefsPage, decodeGitHubRepositoryPage } from "./decoder";

const MAX_REF_PAGES = 10;

export function createGitHubProvider(client: BridgeClient): RepositoryProvider {
  let disposed = false;

  const ensureActive = (signal?: AbortSignal): void => {
    if (disposed || signal?.aborted) throw new RepositoryError("cancelled");
  };

  const request = async (operation: GitHubBridgeOperation, signal?: AbortSignal): Promise<string> => {
    ensureActive(signal);
    const value = await client.request<unknown>(operation, { signal });
    ensureActive(signal);
    if (typeof value !== "string") throw new RepositoryError("compatibility");
    return value;
  };

  const listRefs = async (
    repository: string,
    kind: RefOption["kind"],
    signal?: AbortSignal,
  ): Promise<RefOption[]> => {
    const refs = new Map<string, RefOption>();
    const cursors = new Set<string>();
    let after: string | null = null;
    for (let index = 0; index < MAX_REF_PAGES; index++) {
      const page = index + 1;
      const operation: GitHubBridgeOperation = kind === "branch"
        ? { platform: "github", type: "refs-page", repository, kind: "branches", page }
        : { platform: "github", type: "refs-page", repository, kind: "tags", after };
      const html = await request(operation, signal);
      const decoded = decodeGitHubRefsPage(html, kind === "branch"
        ? { kind: "branches", repository, page }
        : { kind: "tags", repository, after });
      ensureActive(signal);
      for (const ref of decoded.refs) {
        if (!refs.has(ref.name)) refs.set(ref.name, { kind, name: ref.name, sha: ref.sha });
      }
      if (!decoded.hasNextPage) {
        const result = [...refs.values()].sort((left, right) =>
          left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
        ensureActive(signal);
        return result;
      }
      if (kind === "tag") {
        const nextCursor = decoded.nextCursor;
        if (nextCursor === undefined || nextCursor === after || cursors.has(nextCursor)) {
          throw new RepositoryError("compatibility");
        }
        cursors.add(nextCursor);
        after = nextCursor;
      }
    }
    throw new RepositoryError("compatibility");
  };

  return {
    async getHead(repository, signal) {
      const html = await request({
        platform: "github", type: "repository-page", repository,
        ref: null, path: "", view: "root",
      }, signal);
      const page = decodeGitHubRepositoryPage(html, {
        repository, ref: null, path: "", view: "root",
      });
      ensureActive(signal);
      return page.head;
    },
    async listDirectory(repository, ref, path, signal) {
      const expected = path === ""
        ? { repository, ref: null, path: "", view: "root" as const }
        : { repository, ref, path, view: "tree" as const };
      const html = await request({ platform: "github", type: "repository-page", ...expected }, signal);
      const page = decodeGitHubRepositoryPage(html, expected);
      if (page.head !== ref) throw new RepositoryError("compatibility");
      ensureActive(signal);
      return page.listing;
    },
    listBranches: (repository, signal) => listRefs(repository, "branch", signal),
    listTags: (repository, signal) => listRefs(repository, "tag", signal),
    dispose() {
      if (disposed) return;
      disposed = true;
      client.dispose();
    },
  };
}
