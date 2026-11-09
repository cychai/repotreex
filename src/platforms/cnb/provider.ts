export type EntryKind = "directory" | "file" | "link" | "submodule";
export type RepositoryEntry = { kind: EntryKind; name: string; path: string; sha: string | null };
export type DirectoryListing = { path: string; sha: string; entries: RepositoryEntry[] };
export type RefOption = { kind: "branch" | "tag"; name: string; sha: string | null };

export interface RepositoryProvider {
  getHead(repo: string, signal?: AbortSignal): Promise<string>;
  listDirectory(repo: string, ref: string, path: string, signal?: AbortSignal): Promise<DirectoryListing>;
  listBranches(repo: string, signal?: AbortSignal): Promise<RefOption[]>;
  listTags(repo: string, signal?: AbortSignal): Promise<RefOption[]>;
  dispose(): void;
}

import { RepositoryError } from "../../shared/errors";
import type { CnbBridgeOperation, TreeContent, TreeEntry, TreeEntryType } from "../../shared/protocol";
import type { BridgeClient } from "../../content/bridge-client";

const entryKinds: Record<TreeEntryType, EntryKind> = {
  tree: "directory", blob: "file", link: "link", submodule: "submodule",
};

// Capture isolated-world intrinsics; never call methods supplied by a payload.
const isArray = Array.isArray;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;

function requireRecord(value: unknown): object {
  if (typeof value !== "object" || value === null || isArray(value)) throw new RepositoryError("compatibility");
  return value;
}

function ownDataDescriptor(value: object, key: string): PropertyDescriptor | undefined {
  const descriptor = getOwnPropertyDescriptor(value, key);
  if (descriptor && !("value" in descriptor)) throw new RepositoryError("compatibility");
  return descriptor;
}

function ownData(value: object, key: string): unknown {
  const descriptor = ownDataDescriptor(value, key);
  if (!descriptor) throw new RepositoryError("compatibility");
  return descriptor.value;
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

function snapshotArray<T>(value: unknown, snapshot: (item: unknown) => T, maximum = 0xffff_ffff): T[] {
  if (!isArray(value)) throw new RepositoryError("compatibility");
  const length = ownData(value, "length");
  if (typeof length !== "number" || !Number.isInteger(length) || length < 0 || length > maximum) {
    throw new RepositoryError("compatibility");
  }
  const result: T[] = [];
  for (let index = 0; index < length; index++) {
    // Own descriptors reject holes/accessors, without consulting an iterator or map.
    result[index] = snapshot(ownData(value, String(index)));
  }
  return result;
}

function snapshotTreeEntry(value: unknown): TreeEntry {
  const record = requireRecord(value);
  const type = ownData(record, "type");
  const path = ownData(record, "path");
  const name = ownData(record, "name");
  const sha = ownData(record, "sha");
  const size = ownDataDescriptor(record, "size");
  if (!isEntryType(type) || !isNonEmptyString(path) || !isNonEmptyString(name) || !isNonEmptyString(sha) ||
    (size && !isSize(size.value))) throw new RepositoryError("compatibility");
  return { type, path, name, sha };
}

function snapshotTreeContent(value: unknown): TreeContent {
  const record = requireRecord(value);
  const type = ownData(record, "type");
  const path = ownData(record, "path");
  const name = ownData(record, "name");
  const sha = ownData(record, "sha");
  const size = ownData(record, "size");
  const entries = ownData(record, "entries");
  if (type !== "tree" || typeof path !== "string" || typeof name !== "string" ||
    !isNonEmptyString(sha) || !isSize(size)) throw new RepositoryError("compatibility");
  return { type, path, name, sha, size, entries: snapshotArray(entries, snapshotTreeEntry) };
}

function snapshotHead(value: unknown): { name: string } {
  const record = requireRecord(value);
  const name = ownData(record, "name");
  if (!isNonEmptyString(name)) throw new RepositoryError("compatibility");
  return { name };
}

function snapshotRef(value: unknown): { name: string; sha: string } {
  const record = requireRecord(value);
  const name = ownData(record, "name");
  const directSha = ownDataDescriptor(record, "sha")?.value;
  const commit = ownDataDescriptor(record, "commit")?.value;
  const sha = directSha ?? (commit === undefined ? undefined : ownData(requireRecord(commit), "sha"));
  if (!isNonEmptyString(name) || !isNonEmptyString(sha)) throw new RepositoryError("compatibility");
  return { name, sha };
}

function inspectPayload<T>(snapshot: () => T): T {
  try {
    return snapshot();
  } catch {
    // Descriptor inspection can invoke Proxy traps. Never expose their thrown values.
    // This synchronous boundary excludes client requests and their trusted errors.
    throw new RepositoryError("compatibility");
  }
}

export function createCnbProvider(client: BridgeClient): RepositoryProvider {
  let disposed = false;

  const ensureActive = (signal?: AbortSignal) => {
    if (disposed || signal?.aborted) throw new RepositoryError("cancelled");
  };

  const request = async (operation: CnbBridgeOperation, signal?: AbortSignal): Promise<unknown> => {
    ensureActive(signal);
    // Never trust the client's generic type assertion at the unvalidated DTO boundary.
    const data = await client.request<unknown>(operation, { signal });
    return data;
  };

  const listRefs = async (repo: string, kind: RefOption["kind"], signal?: AbortSignal): Promise<RefOption[]> => {
    const refs = new Map<string, RefOption>();
    for (let page = 1; ; page++) {
      const data = await request({
        platform: "cnb", type: kind === "branch" ? "list-branches" : "list-tags",
        repository: repo, page, pageSize: 100,
      }, signal);
      ensureActive(signal);
      const refsPage = inspectPayload(() => snapshotArray(data, snapshotRef, 100));
      ensureActive(signal);
      for (const ref of refsPage) {
        if (!refs.has(ref.name)) refs.set(ref.name, { kind, name: ref.name, sha: ref.sha });
      }
      // Use the raw page length, not the unique count, to determine completion.
      if (refsPage.length < 100) break;
    }
    const result = [...refs.values()].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    ensureActive(signal);
    return result;
  };

  return {
    async getHead(repo, signal) {
      const data = await request({ platform: "cnb", type: "get-head", repository: repo }, signal);
      ensureActive(signal);
      const head = inspectPayload(() => snapshotHead(data));
      ensureActive(signal);
      return head.name;
    },
    async listDirectory(repo, ref, path, signal) {
      const data = await request({
        platform: "cnb", type: "list-directory", repository: repo, ref, path,
      }, signal);
      ensureActive(signal);
      const tree = inspectPayload(() => snapshotTreeContent(data));
      const result = {
        path: tree.path, sha: tree.sha,
        entries: tree.entries.map((entry) => ({
          kind: entryKinds[entry.type], name: entry.name, path: entry.path, sha: entry.sha,
        })),
      };
      ensureActive(signal);
      return result;
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
