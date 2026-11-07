import { RepositoryError } from "../shared/errors";
import type {
  Branch, BridgeOperation, HeadRef, Tag, TreeContent, TreeEntry, TreeEntryType,
} from "../shared/protocol";
import type { BridgeClient } from "./bridge-client";

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

const entryKinds: Record<TreeEntryType, EntryKind> = {
  tree: "directory", blob: "file", link: "link", submodule: "submodule",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwnFields(value: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => Object.hasOwn(value, field));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isEntryType(value: unknown): value is TreeEntryType {
  return value === "tree" || value === "blob" || value === "link" || value === "submodule";
}

function isTreeEntry(value: unknown): value is TreeEntry {
  return isRecord(value) && hasOwnFields(value, ["type", "path", "name", "sha"]) &&
    isEntryType(value.type) && isNonEmptyString(value.path) &&
    isNonEmptyString(value.name) && isNonEmptyString(value.sha) &&
    (!("size" in value) || (Object.hasOwn(value, "size") && isSize(value.size)));
}

function isTreeContent(value: unknown): value is TreeContent {
  if (!isRecord(value) || !hasOwnFields(value, ["type", "path", "name", "sha", "size", "entries"]) ||
    value.type !== "tree" || typeof value.path !== "string" || typeof value.name !== "string" ||
    !isNonEmptyString(value.sha) || !isSize(value.size) || !Array.isArray(value.entries)) return false;
  // Iteration visits sparse slots as undefined; Array.every would silently skip them.
  for (const entry of value.entries) {
    if (!isTreeEntry(entry)) return false;
  }
  return true;
}

function isRef(value: unknown): value is HeadRef | Branch | Tag {
  return isRecord(value) && hasOwnFields(value, ["name", "sha"]) &&
    isNonEmptyString(value.name) && isNonEmptyString(value.sha);
}

function isRefPage(value: unknown): value is (Branch | Tag)[] {
  if (!Array.isArray(value) || value.length > 100) return false;
  for (const ref of value) {
    if (!isRef(ref)) return false;
  }
  return true;
}

export function createSessionProvider(client: BridgeClient): RepositoryProvider {
  let disposed = false;

  const ensureActive = (signal?: AbortSignal) => {
    if (disposed || signal?.aborted) throw new RepositoryError("cancelled");
  };

  const request = async (operation: BridgeOperation, signal?: AbortSignal): Promise<unknown> => {
    ensureActive(signal);
    // Never trust the client's generic type assertion at the unvalidated DTO boundary.
    const data = await client.request<unknown>(operation, { signal });
    return data;
  };

  const listRefs = async (repo: string, kind: RefOption["kind"], signal?: AbortSignal): Promise<RefOption[]> => {
    const refs = new Map<string, RefOption>();
    for (let page = 1; ; page++) {
      const data = await request({
        type: kind === "branch" ? "list-branches" : "list-tags", repo, page, pageSize: 100,
      }, signal);
      ensureActive(signal);
      if (!isRefPage(data)) throw new RepositoryError("compatibility");
      for (const ref of data) {
        if (!refs.has(ref.name)) refs.set(ref.name, { kind, name: ref.name, sha: ref.sha });
      }
      // Use the raw page length, not the unique count, to determine completion.
      if (data.length < 100) break;
    }
    return [...refs.values()].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  };

  return {
    async getHead(repo, signal) {
      const data = await request({ type: "get-head", repo }, signal);
      ensureActive(signal);
      if (!isRef(data)) throw new RepositoryError("compatibility");
      return data.name;
    },
    async listDirectory(repo, ref, path, signal) {
      const data = await request({ type: "list-directory", repo, ref, path }, signal);
      ensureActive(signal);
      if (!isTreeContent(data)) throw new RepositoryError("compatibility");
      return {
        path: data.path, sha: data.sha,
        entries: data.entries.map((entry) => ({
          kind: entryKinds[entry.type], name: entry.name, path: entry.path, sha: entry.sha,
        })),
      };
    },
    listBranches: (repo, signal) => listRefs(repo, "branch", signal),
    listTags: (repo, signal) => listRefs(repo, "tag", signal),
    dispose() {
      if (disposed) return;
      disposed = true;
      client.dispose();
    },
  };
}
