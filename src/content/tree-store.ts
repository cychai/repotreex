import { RepositoryError, type RepositoryErrorCode } from "../shared/errors";
import type { DirectoryListing, RepositoryEntry, RepositoryProvider } from "./provider";

export type TreeDirectoryError = Readonly<{
  code: RepositoryErrorCode;
  status?: number;
  retryAfter?: number;
}>;

export type TreeNode = Readonly<RepositoryEntry & {
  parentPath: string | null;
  depth: number;
  childPaths: readonly string[];
  loaded: boolean;
  loading: boolean;
  expanded: boolean;
  selected: boolean;
  error: TreeDirectoryError | null;
}>;

export type TreeSnapshot = Readonly<{
  repo: string | null;
  ref: string | null;
  nodesByPath: Readonly<Record<string, TreeNode>>;
  visibleNodes: readonly TreeNode[];
  expandedPaths: readonly string[];
  selectedPath: string | null;
}>;

export interface TreeStore {
  startSession(repo: string, ref: string): void;
  loadDirectory(path: string): Promise<void>;
  toggleDirectory(path: string): Promise<void>;
  selectPath(path: string | null): void;
  clearSensitiveData(): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): TreeSnapshot;
  dispose(): void;
}

type StoredNode = RepositoryEntry & {
  parentPath: string | null;
  depth: number;
  childPaths: string[];
  loaded: boolean;
  loading: boolean;
  error: TreeDirectoryError | null;
};

type PendingLoad = {
  path: string | null;
  sessionId: number;
  controller: AbortController;
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  onAbort(): void;
};

export function createTreeStore(provider: RepositoryProvider): TreeStore {
  const nodes = new Map<string, StoredNode>();
  const expanded = new Set<string>();
  const pending = new Map<string, PendingLoad>();
  const subscribers = new Set<() => void>();
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  let repo: string | null = null;
  let ref: string | null = null;
  let selectedPath: string | null = null;
  let sessionId = 0;
  let disposed = false;
  let snapshot: TreeSnapshot | undefined;

  const getSnapshot = (): TreeSnapshot => {
    if (snapshot) return snapshot;
    const nodesByPath = Object.fromEntries([...nodes].map(([path, node]) => [path, Object.freeze({
      ...node,
      childPaths: Object.freeze([...node.childPaths]),
      expanded: expanded.has(path),
      selected: selectedPath === path,
      error: node.error === null ? null : Object.freeze({ ...node.error }),
    })]));
    const visibleNodes: TreeNode[] = [];
    const stack = [...(nodes.get("")?.childPaths ?? [])].reverse();
    while (stack.length > 0) {
      const path = stack.pop();
      if (path === undefined) break;
      const node = nodesByPath[path];
      visibleNodes.push(node);
      if (node.kind === "directory" && node.expanded) {
        for (let index = node.childPaths.length - 1; index >= 0; index--) stack.push(node.childPaths[index]);
      }
    }
    snapshot = Object.freeze({
      repo, ref, selectedPath,
      nodesByPath: Object.freeze(nodesByPath),
      visibleNodes: Object.freeze(visibleNodes),
      expandedPaths: Object.freeze([...expanded]),
    });
    return snapshot;
  };

  const publish = () => {
    snapshot = undefined;
    const failures: unknown[] = [];
    for (const listener of [...subscribers]) {
      if (!subscribers.has(listener)) continue;
      try {
        listener();
      } catch (error) {
        failures.push(error);
      }
    }
    // Security-clearing consumers must all run before any notification failure escapes.
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Subscriber notification failed");
  };

  const ensureActive = () => {
    if (disposed || repo === null || ref === null) throw new RepositoryError("cancelled");
  };

  const requireDirectory = (path: string): StoredNode => {
    ensureActive();
    const node = nodes.get(path);
    if (!node) throw new RepositoryError("not-found");
    if (node.kind !== "directory") throw new RepositoryError("compatibility");
    return node;
  };

  const isCurrent = (request: PendingLoad) =>
    !disposed && request.sessionId === sessionId && !request.controller.signal.aborted;

  const finishRequest = (request: PendingLoad) => {
    if (request.path !== null && pending.get(request.path) === request) pending.delete(request.path);
    request.controller.signal.removeEventListener("abort", request.onAbort);
    // Late provider continuations retain this request, but not its repository path.
    request.path = null;
  };

  const clearSensitiveData = () => {
    sessionId++;
    repo = null;
    ref = null;
    selectedPath = null;
    nodes.clear();
    expanded.clear();
    snapshot = undefined;
    const requests = [...pending.values()];
    pending.clear();
    for (const request of requests) request.controller.abort();
    publish();
  };

  const settleSuccess = (request: PendingLoad, listing: DirectoryListing) => {
    if (!isCurrent(request) || request.path === null) {
      request.reject(new RepositoryError("cancelled"));
      return;
    }
    const path = request.path;
    const node = nodes.get(path);
    if (!node) throw new RepositoryError("cancelled");
    const entries = [...listing.entries].sort((left, right) => {
      const kindOrder = Number(right.kind === "directory") - Number(left.kind === "directory");
      return kindOrder || collator.compare(left.name, right.name);
    });
    for (const entry of entries) {
      nodes.set(entry.path, {
        kind: entry.kind, name: entry.name, path: entry.path, sha: entry.sha,
        parentPath: path, depth: node.depth + 1, childPaths: [],
        loaded: false, loading: false, error: null,
      });
    }
    node.sha = listing.sha;
    node.childPaths = entries.map((entry) => entry.path);
    node.loaded = true;
    node.loading = false;
    node.error = null;
    finishRequest(request);
    publish();
    // A subscriber can synchronously clear/replace the session while rendering.
    if (!isCurrent(request)) request.reject(new RepositoryError("cancelled"));
    else request.resolve();
  };

  const settleFailure = (request: PendingLoad, error: unknown) => {
    if (!isCurrent(request) || request.path === null) {
      request.reject(new RepositoryError("cancelled"));
      return;
    }
    const node = nodes.get(request.path);
    finishRequest(request);
    // Provider rejection takes precedence over notification failures. Promise reactions
    // run only after the synchronous clearing/fan-out below has completed.
    request.reject(error);
    if (error instanceof RepositoryError && (error.code === "signed-out" || error.code === "forbidden")) {
      request.controller.abort();
      clearSensitiveData();
    } else if (node) {
      node.loading = false;
      node.error = error instanceof RepositoryError
        ? error.code === "cancelled" ? null : Object.freeze({
          code: error.code,
          ...(error.status === undefined ? {} : { status: error.status }),
          ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
        })
        : Object.freeze({ code: "compatibility" });
      publish();
    }
  };

  const beginLoad = (path: string): PendingLoad => {
    const controller = new AbortController();
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const request: PendingLoad = {
      path, sessionId, controller, promise, resolve, reject,
      onAbort() {
        finishRequest(request);
        reject(new RepositoryError("cancelled"));
      },
    };
    controller.signal.addEventListener("abort", request.onAbort, { once: true });
    pending.set(path, request);
    // Register before publishing loading state; a subscriber may replace the session.
    void Promise.resolve().then(() => {
      if (!isCurrent(request) || request.path === null || repo === null || ref === null) {
        throw new RepositoryError("cancelled");
      }
      return provider.listDirectory(repo, ref, request.path, controller.signal);
    }).then(
      (listing) => settleSuccess(request, listing),
      (error: unknown) => settleFailure(request, error),
    ).catch((error: unknown) => {
      // Propagate synchronous provider/subscriber failures, never manufacture success.
      finishRequest(request);
      reject(error);
    });
    return request;
  };

  const loadDirectory = (path: string): Promise<void> => {
    let node: StoredNode;
    try {
      node = requireDirectory(path);
    } catch (error) {
      return Promise.reject(error);
    }
    const existing = pending.get(path);
    if (existing) return existing.promise;
    if (node.loaded) return Promise.resolve();
    const request = beginLoad(path);
    node.loading = true;
    node.error = null;
    try {
      publish();
    } catch (error) {
      node.loading = false;
      snapshot = undefined;
      request.reject(error);
      request.controller.abort();
    }
    return request.promise;
  };

  return {
    startSession(nextRepo, nextRef) {
      if (disposed) throw new RepositoryError("cancelled");
      const clearedSessionId = sessionId + 1;
      clearSensitiveData();
      if (disposed || sessionId !== clearedSessionId) throw new RepositoryError("cancelled");
      sessionId++;
      repo = nextRepo;
      ref = nextRef;
      nodes.set("", {
        kind: "directory", name: "", path: "", sha: "", parentPath: null, depth: 0,
        childPaths: [], loaded: false, loading: false, error: null,
      });
      publish();
    },
    loadDirectory,
    async toggleDirectory(path) {
      requireDirectory(path);
      if (expanded.delete(path)) {
        publish();
        return;
      }
      expanded.add(path);
      const currentSessionId = sessionId;
      publish();
      if (disposed || currentSessionId !== sessionId) throw new RepositoryError("cancelled");
      await loadDirectory(path);
    },
    selectPath(path) {
      ensureActive();
      if (path !== null && !nodes.has(path)) throw new RepositoryError("not-found");
      if (selectedPath === path) return;
      selectedPath = path;
      publish();
    },
    clearSensitiveData,
    subscribe(listener) {
      if (disposed) throw new RepositoryError("cancelled");
      subscribers.add(listener);
      return () => { subscribers.delete(listener); };
    },
    getSnapshot,
    dispose() {
      if (disposed) return;
      disposed = true;
      const failures: unknown[] = [];
      try {
        clearSensitiveData();
      } catch (error) {
        failures.push(error);
      }
      subscribers.clear();
      try {
        provider.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Store disposal failed");
    },
  };
}
