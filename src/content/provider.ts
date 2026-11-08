export type EntryKind = "directory" | "file" | "link" | "submodule";
export type RepositoryEntry = { kind: EntryKind; name: string; path: string; sha: string };
export type DirectoryListing = { path: string; sha: string; entries: RepositoryEntry[] };
export type RefOption = { kind: "branch" | "tag"; name: string; sha: string };

export interface RepositoryProvider {
  getHead(repo: string, signal?: AbortSignal): Promise<string>;
  listDirectory(repo: string, ref: string, path: string, signal?: AbortSignal): Promise<DirectoryListing>;
  listBranches(repo: string, signal?: AbortSignal): Promise<RefOption[]>;
  listTags(repo: string, signal?: AbortSignal): Promise<RefOption[]>;
  dispose(): void;
}

import { createCnbProvider } from "../platforms/cnb/provider";

export { createCnbProvider };

/** @deprecated Use createCnbProvider. */
export const createSessionProvider = createCnbProvider;
