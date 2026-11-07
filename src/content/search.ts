import { RepositoryError } from "../shared/errors";
import type { TreeNode, TreeSnapshot, TreeStore } from "./tree-store";

export type LoadedNodeMatches = TreeNode[] & { hasMoreMatches: boolean };

export type TraversalProgress = Readonly<{
  loadedNodes: number;
  queuedDirectories: number;
  activeRequests: number;
}>;

export type TraversalResult = Readonly<{
  loadedNodes: number;
  truncated: boolean;
  cancelled: boolean;
}>;

export type TraversalOptions = {
  concurrency?: number;
  maxNodes?: number;
  signal?: AbortSignal;
  onProgress?: (progress: TraversalProgress) => void;
};

export function matchLoadedNodes(snapshot: TreeSnapshot, query: string): LoadedNodeMatches {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized === "") return Object.assign([], { hasMoreMatches: false });
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const matches: { node: TreeNode; rank: number }[] = [];
  for (const node of Object.values(snapshot.nodesByPath)) {
    if (node.path === "") continue;
    const basename = node.name.toLocaleLowerCase();
    const rank = basename.startsWith(normalized) ? 0 : basename.includes(normalized) ? 1
      : node.path.toLocaleLowerCase().includes(normalized) ? 2 : -1;
    if (rank !== -1) matches.push({ node, rank });
  }
  matches.sort((left, right) => left.rank - right.rank || left.node.path.length - right.node.path.length
    || collator.compare(left.node.path, right.node.path)
    || (left.node.path < right.node.path ? -1 : left.node.path > right.node.path ? 1 : 0));
  return Object.assign(matches.slice(0, 200).map(({ node }) => node), { hasMoreMatches: matches.length > 200 });
}

type DirectoryRequest = { path: string | null; publish: ((settlement: DirectorySettlement) => void) | null };
type DirectorySettlement = { request: DirectoryRequest } & ({ ok: true } | { ok: false; error: unknown });

function observeDirectory(request: DirectoryRequest, load: Promise<void>): void {
  // These late continuations capture only the detachable request, not call state.
  void load.then(
    () => request.publish?.({ request, ok: true }),
    (error: unknown) => request.publish?.({ request, ok: false, error }),
  );
}

function isCancellation(error: unknown): boolean {
  return error instanceof RepositoryError && error.code === "cancelled"
    || (error instanceof Error || error instanceof DOMException) && error.name === "AbortError";
}

export async function loadFullTree(store: Pick<TreeStore, "loadDirectory" | "getSnapshot">, options: TraversalOptions = {}): Promise<TraversalResult> {
  const { concurrency = 4, maxNodes = 10_000, signal, onProgress } = options;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError("Invalid traversal concurrency");
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 0) throw new RangeError("Invalid traversal node ceiling");

  const queue: string[] = [];
  const visited = new Set<string>();
  const discovered = new Set<string>();
  const active = new Set<DirectoryRequest>();
  const settlements: DirectorySettlement[] = [];
  let cursor = 0;
  let loadedNodes = 0;
  let truncated = maxNodes === 0;
  let cancelled = signal?.aborted ?? false;
  let failure: { error: unknown } | undefined;
  let rootLoaded = false;
  let repo: string | null = null;
  let ref: string | null = null;
  let wake: (() => void) | undefined;
  const onAbort = () => { cancelled = true; wake?.(); };
  const publish = (settlement: DirectorySettlement) => {
    settlements.push(settlement);
    wake?.();
  };

  const count = (node: TreeNode) => {
    if (node.path === "" || discovered.has(node.path) || truncated) return;
    discovered.add(node.path);
    loadedNodes++;
    if (loadedNodes === maxNodes) truncated = true;
  };

  const enqueue = (node: TreeNode) => {
    if (node.kind !== "directory" || visited.has(node.path) || truncated) return;
    visited.add(node.path);
    queue.push(node.path);
  };

  const currentSnapshot = (): TreeSnapshot | undefined => {
    const snapshot = store.getSnapshot();
    const root = snapshot.nodesByPath[""];
    if (snapshot.repo !== repo || snapshot.ref !== ref || !root || rootLoaded && !root.loaded) {
      cancelled = true;
      return undefined;
    }
    return snapshot;
  };

  try {
    if (cancelled) return { loadedNodes, truncated, cancelled };
    signal?.addEventListener("abort", onAbort, { once: true });
    const initial = store.getSnapshot();
    repo = initial.repo;
    ref = initial.ref;
    const root = initial.nodesByPath[""];
    if (repo === null || ref === null || !root) return { loadedNodes, truncated, cancelled: true };
    rootLoaded = root.loaded;
    for (const node of Object.values(initial.nodesByPath)) {
      count(node);
      if (truncated) break;
    }
    enqueue(root);

    while (cursor < queue.length || active.size > 0) {
      while (!truncated && !cancelled && !failure && active.size < concurrency && cursor < queue.length) {
        if (!currentSnapshot()) break;
        const path = queue[cursor++];
        const request: DirectoryRequest = { path, publish };
        active.add(request);
        // Attach directly: promise adoption would postpone observing an auth
        // rejection until after the store's synchronous clearing/abort wakes us.
        void Promise.resolve().then(() => {
          try {
            if (request.path === null || cancelled || !currentSnapshot()) throw new RepositoryError("cancelled");
            observeDirectory(request, store.loadDirectory(request.path));
          } catch (error) {
            request.publish?.({ request, ok: false, error });
          }
        });
      }
      if (active.size === 0) break;
      if (settlements.length === 0 && !signal?.aborted) await new Promise<void>((resolve) => { wake = resolve; });
      wake = undefined;
      // Drain every already-settled directory before refilling concurrency slots.
      // Even after abort, inspect the entire observed batch for fatal failures;
      // only genuinely late continuations are detached without inspection.
      for (const settlement of settlements.splice(0)) {
        const { request } = settlement;
        active.delete(request);
        const path = request.path;
        request.path = null;
        request.publish = null;
        if (!settlement.ok) {
          if (isCancellation(settlement.error)) cancelled = true;
          else failure ??= { error: settlement.error };
        } else if (!cancelled && !failure) {
          const snapshot = currentSnapshot();
          if (snapshot && path !== null) {
            rootLoaded = snapshot.nodesByPath[""].loaded;
            const directory = snapshot.nodesByPath[path];
            if (!directory?.loaded) cancelled = true;
            else for (const childPath of directory.childPaths) {
              const child = snapshot.nodesByPath[childPath];
              count(child);
              enqueue(child);
              if (truncated) break;
            }
          }
        }
        if (!signal?.aborted) {
          try {
            onProgress?.({ loadedNodes, queuedDirectories: queue.length - cursor, activeRequests: active.size });
          } catch (error) {
            failure ??= { error };
          }
        }
      }
      // Truncation alone drains in-flight work. Fatal failure/cancellation exits
      // promptly, so an unrelated stalled request cannot block error delivery.
      if (failure || cancelled) break;
    }
    if (failure) throw failure.error;
    return { loadedNodes, truncated, cancelled };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    for (const request of active) { request.path = null; request.publish = null; }
    active.clear();
    settlements.length = 0;
    wake = undefined;
    queue.length = 0;
    visited.clear();
    discovered.clear();
    repo = null;
    ref = null;
  }
}
