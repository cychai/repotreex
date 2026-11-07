import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectoryListing, EntryKind, RepositoryEntry, RepositoryProvider } from "../src/content/provider";
import { loadFullTree, matchLoadedNodes, type TraversalProgress } from "../src/content/search";
import { createTreeStore, type TreeNode, type TreeSnapshot, type TreeStore } from "../src/content/tree-store";
import { RepositoryError } from "../src/shared/errors";

function entry(path: string, kind: EntryKind = "file"): RepositoryEntry {
  return { path, name: path.split("/").at(-1) ?? "", kind, sha: "synthetic-sha" };
}

function listing(path: string, entries: RepositoryEntry[] = []): DirectoryListing {
  return { path, sha: "synthetic-sha", entries };
}

function snapshotWithPaths(paths: string[]): TreeSnapshot {
  const nodes: TreeNode[] = ["", ...paths].map((path) => Object.freeze({
    ...entry(path, path === "" ? "directory" : "file"),
    parentPath: path === "" ? null : "", depth: path === "" ? 0 : 1,
    childPaths: Object.freeze([]), loaded: false, loading: false,
    expanded: false, selected: false, error: null,
  }));
  return Object.freeze({
    repo: "synthetic/repo", ref: "main", nodesByPath: Object.freeze(Object.fromEntries(nodes.map((node) => [node.path, node]))),
    visibleNodes: Object.freeze([]), expandedPaths: Object.freeze([]), selectedPath: null,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const stores: TreeStore[] = [];

function setup(listDirectory: RepositoryProvider["listDirectory"] = async (_repo, _ref, path) => listing(path)) {
  const provider: RepositoryProvider = {
    getHead: async () => "main", listDirectory, listBranches: async () => [], listTags: async () => [], dispose() {},
  };
  const store = createTreeStore(provider);
  stores.push(store);
  store.startSession("synthetic/repo", "main");
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.restoreAllMocks();
});

describe("filename search", () => {
  it("matches trimmed path substrings case-insensitively, including collapsed cached nodes", () => {
    const snapshot = snapshotWithPaths(["src/RepoTree.ts", "docs/design.md", "README.md"]);
    const result = matchLoadedNodes(snapshot, "  REPO  ");
    expect(result.map((node) => node.path)).toEqual(["src/RepoTree.ts"]);
    expect(result[0]).toBe(snapshot.nodesByPath["src/RepoTree.ts"]);
    expect(result.hasMoreMatches).toBe(false);
    expect(snapshot.visibleNodes).toEqual([]);
  });

  it.each(["", " \t\n", "absent"])("returns no results or overflow state for %j", (query) => {
    const result = matchLoadedNodes(snapshotWithPaths(["README.md"]), query);
    expect(result).toHaveLength(0);
    expect(result.hasMoreMatches).toBe(false);
  });

  it("uses locale-aware case conversion", () => {
    const snapshot = snapshotWithPaths(["src/FILE.ts"]);
    const lower = vi.spyOn(String.prototype, "toLocaleLowerCase");
    expect(matchLoadedNodes(snapshot, "file").map((node) => node.path)).toEqual(["src/FILE.ts"]);
    expect(lower).toHaveBeenCalled();
  });

  it("ranks basename prefixes before basename substrings before full-path matches", () => {
    const snapshot = snapshotWithPaths(["repo/a", "arepo", "long/path/RepoTree.ts", "repo.ts", "xrepo.ts"]);
    expect(matchLoadedNodes(snapshot, "repo").map((node) => node.path)).toEqual([
      "repo.ts", "long/path/RepoTree.ts", "arepo", "xrepo.ts", "repo/a",
    ]);
  });

  it("breaks same-rank ties by path length, then natural ordering", () => {
    expect(matchLoadedNodes(snapshotWithPaths(["item10", "item02", "item01", "item2", "item1"]), "item")
      .map((node) => node.path)).toEqual(["item1", "item2", "item01", "item02", "item10"]);
  });

  it("matches non-ASCII case and treats query punctuation literally", () => {
    const snapshot = snapshotWithPaths(["src/\u00c4PFEL.ts", "literal[1].ts", "literal2.ts"]);
    expect(matchLoadedNodes(snapshot, "\u00e4pfel").map((node) => node.path)).toEqual(["src/\u00c4PFEL.ts"]);
    expect(matchLoadedNodes(snapshot, "[1]").map((node) => node.path)).toEqual(["literal[1].ts"]);
  });

  it("makes case-equivalent natural ties deterministic independent of insertion order", () => {
    expect(matchLoadedNodes(snapshotWithPaths(["a.ts", "A.ts"]), "a").map((node) => node.path)).toEqual(["A.ts", "a.ts"]);
  });

  it("ranks all candidates before capping results at 200 and exposing overflow", () => {
    const paths = Array.from({ length: 200 }, (_, index) => `match/long-file-${index}`);
    const snapshot = snapshotWithPaths([...paths, "match.ts"]);
    const result = matchLoadedNodes(snapshot, "match");
    expect(result).toHaveLength(200);
    expect(result[0].path).toBe("match.ts");
    expect(result.hasMoreMatches).toBe(true);
    expect(Object.keys(snapshot.nodesByPath)).toHaveLength(202);
  });

  it("does not report overflow at exactly 200 matches", () => {
    const result = matchLoadedNodes(snapshotWithPaths(Array.from({ length: 200 }, (_, index) => `file${index}`)), "file");
    expect(result).toHaveLength(200);
    expect(result.hasMoreMatches).toBe(false);
  });

  it("keeps independent result arrays and never changes snapshot selection or expansions", () => {
    const snapshot = snapshotWithPaths(["a.ts", "b.ts"]);
    const first = matchLoadedNodes(snapshot, "a");
    first.pop();
    expect(matchLoadedNodes(snapshot, "a").map((node) => node.path)).toEqual(["a.ts"]);
    expect(matchLoadedNodes(snapshot, "b").map((node) => node.path)).toEqual(["b.ts"]);
    expect(snapshot.selectedPath).toBeNull();
    expect(snapshot.expandedPaths).toEqual([]);
  });

  it("includes discovered directories, links, and submodules without requiring file content loads", async () => {
    const store = setup(async () => listing("", [entry("match", "directory"), entry("match-link", "link"), entry("match-module", "submodule")]));
    await store.loadDirectory("");
    expect(matchLoadedNodes(store.getSnapshot(), "match").map((node) => node.kind)).toEqual(["directory", "link", "submodule"]);
  });
});

describe("bounded full-tree loading", () => {
  it("loads an empty root without counting the hidden root", async () => {
    const progress: TraversalProgress[] = [];
    const store = setup();
    await expect(loadFullTree(store, { onProgress: (value) => progress.push(value) })).resolves.toEqual({
      loadedNodes: 0, truncated: false, cancelled: false,
    });
    expect(progress).toEqual([{ loadedNodes: 0, queuedDirectories: 0, activeRequests: 0 }]);
    expect(store.getSnapshot().nodesByPath[""].loaded).toBe(true);
  });

  it("counts every entry kind while traversing only directories, without changing UI state", async () => {
    const calls: string[] = [];
    const store = setup(async (_repo, _ref, path) => {
      calls.push(path);
      return path === "" ? listing(path, [entry("src", "directory"), entry("a.ts"), entry("shortcut", "link"), entry("vendor", "submodule")])
        : listing(path, [entry("src/index.ts")]);
    });
    await store.loadDirectory("");
    store.selectPath("a.ts");
    await expect(loadFullTree(store)).resolves.toEqual({ loadedNodes: 5, truncated: false, cancelled: false });
    expect(calls).toEqual(["", "src"]);
    expect(store.getSnapshot().selectedPath).toBe("a.ts");
    expect(store.getSnapshot().expandedPaths).toEqual([]);
  });

  it("stops at the ceiling even when one whole directory listing exceeds it", async () => {
    const calls: string[] = [];
    const store = setup(async (_repo, _ref, path) => {
      calls.push(path);
      return listing(path, Array.from({ length: 20 }, (_, index) => entry(`dir${index}`, "directory")));
    });
    await expect(loadFullTree(store, { concurrency: 2, maxNodes: 5 })).resolves.toEqual({
      loadedNodes: 5, truncated: true, cancelled: false,
    });
    expect(calls).toEqual([""]);
    // Store ingestion is atomic: the traversal bounds scheduling, not shared cached listings.
    expect(Object.keys(store.getSnapshot().nodesByPath)).toHaveLength(21);
  });

  it("defaults to the 10,000 non-root node ceiling", async () => {
    const store = setup(async () => listing("", Array.from({ length: 10_001 }, (_, index) => entry(`file${index}`))));
    await expect(loadFullTree(store)).resolves.toEqual({ loadedNodes: 10_000, truncated: true, cancelled: false });
  });

  it("marks exactly reaching the ceiling as truncated", async () => {
    const store = setup(async () => listing("", [entry("a"), entry("b")]));
    await expect(loadFullTree(store, { maxNodes: 2 })).resolves.toEqual({ loadedNodes: 2, truncated: true, cancelled: false });
  });

  it("counts already loaded descendants before scheduling additional work", async () => {
    const calls: string[] = [];
    const store = setup(async (_repo, _ref, path) => {
      calls.push(path);
      return path === "" ? listing(path, [entry("src", "directory")]) : listing(path, [entry("src/a"), entry("src/b")]);
    });
    await store.loadDirectory("");
    await store.loadDirectory("src");
    await expect(loadFullTree(store, { maxNodes: 2 })).resolves.toEqual({ loadedNodes: 2, truncated: true, cancelled: false });
    expect(calls).toEqual(["", "src"]);
  });

  it("performs no loads with a zero node budget", async () => {
    let calls = 0;
    const store = setup(async () => { calls++; return listing(""); });
    await expect(loadFullTree(store, { maxNodes: 0 })).resolves.toEqual({ loadedNodes: 0, truncated: true, cancelled: false });
    expect(calls).toBe(0);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid concurrency %s without dispatch", async (concurrency) => {
    const store = setup();
    await expect(loadFullTree(store, { concurrency })).rejects.toBeInstanceOf(RangeError);
    expect(store.getSnapshot().nodesByPath[""].loaded).toBe(false);
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid node ceiling %s", async (maxNodes) => {
    await expect(loadFullTree(setup(), { maxNodes })).rejects.toBeInstanceOf(RangeError);
  });

  it("limits default in-flight loads to four and schedules queued siblings before newly discovered children", async () => {
    const calls: string[] = [];
    const responses = new Map<string, ReturnType<typeof deferred<DirectoryListing>>>();
    let active = 0;
    let maximum = 0;
    const store = setup(async (_repo, _ref, path) => {
      calls.push(path);
      if (path === "") return listing(path, ["a", "b", "c", "d", "e"].map((name) => entry(name, "directory")));
      active++;
      maximum = Math.max(maximum, active);
      const response = deferred<DirectoryListing>();
      responses.set(path, response);
      try { return await response.promise; } finally { active--; }
    });
    const traversal = loadFullTree(store);
    await vi.waitFor(() => expect(calls).toEqual(["", "a", "b", "c", "d"]));
    responses.get("a")?.resolve(listing("a", [entry("a/child", "directory")]));
    await vi.waitFor(() => expect(calls).toEqual(["", "a", "b", "c", "d", "e"]));
    responses.get("b")?.resolve(listing("b"));
    await vi.waitFor(() => expect(calls).toEqual(["", "a", "b", "c", "d", "e", "a/child"]));
    for (const [path, response] of responses) response.resolve(listing(path));
    await expect(traversal).resolves.toEqual({ loadedNodes: 6, truncated: false, cancelled: false });
    expect(maximum).toBe(4);
    expect(active).toBe(0);
  });

  it("deduplicates duplicate child paths and does not revisit a directory", async () => {
    const calls: string[] = [];
    const store = setup(async (_repo, _ref, path) => {
      calls.push(path);
      return path === "" ? listing(path, [entry("a", "directory"), entry("a", "directory")])
        : listing(path, [entry("a/file"), entry("a/file")]);
    });
    await expect(loadFullTree(store)).resolves.toEqual({ loadedNodes: 2, truncated: false, cancelled: false });
    expect(calls).toEqual(["", "a"]);
  });

  it("reports independent, monotonic progress after every settled directory", async () => {
    const progress: TraversalProgress[] = [];
    const store = setup(async (_repo, _ref, path) => path === "" ? listing(path, [entry("a", "directory"), entry("b", "directory")])
      : listing(path, [entry(`${path}/file`)]));
    await loadFullTree(store, { concurrency: 1, onProgress: (value) => progress.push(value) });
    expect(progress).toEqual([
      { loadedNodes: 2, queuedDirectories: 2, activeRequests: 0 },
      { loadedNodes: 3, queuedDirectories: 1, activeRequests: 0 },
      { loadedNodes: 4, queuedDirectories: 0, activeRequests: 0 },
    ]);
    expect(progress[0]).not.toBe(progress[1]);
    expect(progress.every((value) => Object.keys(value).length === 3)).toBe(true);
  });

  it("drains in-flight loads at truncation without scheduling queued or newly discovered directories", async () => {
    const a = deferred<DirectoryListing>();
    const b = deferred<DirectoryListing>();
    const calls: string[] = [];
    const progress: TraversalProgress[] = [];
    const signals: AbortSignal[] = [];
    const store = setup((_repo, _ref, path, signal) => {
      calls.push(path);
      if (signal) signals.push(signal);
      return path === "" ? Promise.resolve(listing(path, ["a", "b", "c"].map((name) => entry(name, "directory"))))
        : path === "a" ? a.promise : b.promise;
    });
    let settled = false;
    const traversal = loadFullTree(store, { concurrency: 2, maxNodes: 5, onProgress: (value) => progress.push(value) });
    void traversal.then(() => { settled = true; });
    await vi.waitFor(() => expect(calls).toEqual(["", "a", "b"]));
    a.resolve(listing("a", [entry("a/file"), entry("a/child", "directory")]));
    await vi.waitFor(() => expect(progress).toHaveLength(2));
    expect(settled).toBe(false);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    b.resolve(listing("b", [entry("b/file"), entry("b/child", "directory")]));
    await expect(traversal).resolves.toEqual({ loadedNodes: 5, truncated: true, cancelled: false });
    expect(calls).toEqual(["", "a", "b"]);
    expect(progress.map((value) => value.loadedNodes)).toEqual([3, 5, 5]);
    expect(progress.at(-1)?.activeRequests).toBe(0);
    expect(store.getSnapshot().nodesByPath.b.loaded).toBe(true);
  });

  it("counts all discovered nodes before refilling slots when two loads settle together", async () => {
    const a = deferred<DirectoryListing>();
    const b = deferred<DirectoryListing>();
    const calls: string[] = [];
    const store = setup((_repo, _ref, path) => {
      calls.push(path);
      return path === "" ? Promise.resolve(listing(path, ["a", "b", "c"].map((name) => entry(name, "directory"))))
        : path === "a" ? a.promise : path === "b" ? b.promise : Promise.resolve(listing(path));
    });
    const traversal = loadFullTree(store, { concurrency: 2, maxNodes: 5 });
    await vi.waitFor(() => expect(calls).toEqual(["", "a", "b"]));
    a.resolve(listing("a", [entry("a/file")]));
    b.resolve(listing("b", [entry("b/file")]));
    await expect(traversal).resolves.toEqual({ loadedNodes: 5, truncated: true, cancelled: false });
    expect(calls).toEqual(["", "a", "b"]);
  });

  it("does not refill slots after a concurrent request has already failed", async () => {
    const a = deferred<DirectoryListing>();
    const b = deferred<DirectoryListing>();
    const calls: string[] = [];
    const store = setup((_repo, _ref, path) => {
      calls.push(path);
      return path === "" ? Promise.resolve(listing(path, ["a", "b", "c"].map((name) => entry(name, "directory"))))
        : path === "a" ? a.promise : path === "b" ? b.promise : Promise.resolve(listing(path));
    });
    const traversal = loadFullTree(store, { concurrency: 2 });
    const error = new RepositoryError("rate-limited");
    const rejection = expect(traversal).rejects.toBe(error);
    await vi.waitFor(() => expect(calls).toEqual(["", "a", "b"]));
    a.resolve(listing("a"));
    b.reject(error);
    await rejection;
    expect(calls).toEqual(["", "a", "b"]);
  });

  it("does not revisit cyclic directory edges in an already loaded normalized snapshot", async () => {
    const base = snapshotWithPaths([]);
    const root = { ...base.nodesByPath[""], loaded: true, childPaths: ["a", "a", ""] };
    const directory: TreeNode = { ...root, ...entry("a", "directory"), parentPath: "", depth: 1, childPaths: ["", "a"] };
    const snapshot: TreeSnapshot = { ...base, nodesByPath: { "": root, a: directory } };
    const calls: string[] = [];
    await expect(loadFullTree({ getSnapshot: () => snapshot, async loadDirectory(path) { calls.push(path); } }))
      .resolves.toEqual({ loadedNodes: 1, truncated: false, cancelled: false });
    expect(calls).toEqual(["", "a"]);
  });

  it("releases the abort listener on normal completion and never logs or persists metadata", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "debug")];
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const store = setup(async () => listing("", [entry("__proto__"), entry("constructor"), entry("toString")]));
    await expect(loadFullTree(store)).resolves.toMatchObject({ loadedNodes: 3 });
    await loadFullTree(store, { signal: controller.signal });
    expect(matchLoadedNodes(store.getSnapshot(), "proto").map((node) => node.path)).toEqual(["__proto__"]);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  });

  it.each(["signed-out", "forbidden", "rate-limited", "compatibility", "not-found", "network", "server"] as const)(
    "propagates %s unchanged and reports failed-directory settlement", async (code) => {
      const error = new RepositoryError(code, { status: 429, retryAfter: 12 });
      const progress: TraversalProgress[] = [];
      const store = setup(async () => { throw error; });
      await expect(loadFullTree(store, { onProgress: (value) => progress.push(value) })).rejects.toBe(error);
      expect(progress).toEqual([{ loadedNodes: 0, queuedDirectories: 0, activeRequests: 0 }]);
    },
  );

  it("does not swallow a fatal error from an in-flight request after truncation", async () => {
    const a = deferred<DirectoryListing>();
    const b = deferred<DirectoryListing>();
    const progress: TraversalProgress[] = [];
    const store = setup((_repo, _ref, path) => path === "" ? Promise.resolve(listing(path, [entry("a", "directory"), entry("b", "directory")]))
      : path === "a" ? a.promise : b.promise);
    const traversal = loadFullTree(store, { concurrency: 2, maxNodes: 3, onProgress: (value) => progress.push(value) });
    const error = new RepositoryError("rate-limited", { status: 429, retryAfter: 7 });
    const rejection = expect(traversal).rejects.toBe(error);
    await vi.waitFor(() => expect(store.getSnapshot().nodesByPath.b.loading).toBe(true));
    a.resolve(listing("a", [entry("a/file")]));
    await vi.waitFor(() => expect(progress).toHaveLength(2));
    b.reject(error);
    await rejection;
    expect(progress.at(-1)).toMatchObject({ loadedNodes: 3, activeRequests: 0 });
  });

  it.each([new Error("synthetic failure"), undefined])("propagates unexpected rejection values unchanged (%s)", async (error) => {
    const store = setup(async () => { throw error; });
    await expect(loadFullTree(store)).rejects.toBe(error);
  });

  it.each([new RepositoryError("cancelled"), new DOMException("synthetic abort", "AbortError")])(
    "translates abort rejection into a cancelled result", async (error) => {
      const store = setup(async () => { throw error; });
      await expect(loadFullTree(store)).resolves.toEqual({ loadedNodes: 0, truncated: false, cancelled: true });
    },
  );

  it("returns cancelled without dispatch for a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const store = setup();
    await expect(loadFullTree(store, { signal: controller.signal })).resolves.toEqual({ loadedNodes: 0, truncated: false, cancelled: true });
    expect(store.getSnapshot().nodesByPath[""].loading).toBe(false);
  });

  it("does not dispatch work when aborted immediately after the call", async () => {
    const controller = new AbortController();
    const store = setup();
    const traversal = loadFullTree(store, { signal: controller.signal });
    controller.abort();
    await expect(traversal).resolves.toEqual({ loadedNodes: 0, truncated: false, cancelled: true });
    expect(store.getSnapshot().nodesByPath[""].loaded).toBe(false);
    expect(store.getSnapshot().nodesByPath[""].loading).toBe(false);
  });

  it("does not dispatch into a different session replaced immediately after the call", async () => {
    const store = setup();
    const traversal = loadFullTree(store);
    store.startSession("synthetic/other", "other");
    await expect(traversal).resolves.toMatchObject({ cancelled: true });
    expect(store.getSnapshot().nodesByPath[""].loaded).toBe(false);
    expect(store.getSnapshot().nodesByPath[""].loading).toBe(false);
  });

  it("does not dispatch after a progress callback replaces the same repo/ref session", async () => {
    const calls: string[] = [];
    const store = setup(async (_repo, _ref, path) => { calls.push(path); return listing(path, [entry("a", "directory")]); });
    await expect(loadFullTree(store, { onProgress: () => store.startSession("synthetic/repo", "main") }))
      .resolves.toMatchObject({ loadedNodes: 1, cancelled: true });
    expect(calls).toEqual([""]);
    expect(store.getSnapshot().nodesByPath[""].loaded).toBe(false);
  });

  it("classifies an Error named AbortError as cancellation", async () => {
    const store = setup(async () => { throw Object.assign(new Error("synthetic abort"), { name: "AbortError" }); });
    await expect(loadFullTree(store)).resolves.toEqual({ loadedNodes: 0, truncated: false, cancelled: true });
  });

  it("propagates synchronous store throws without manufacturing successful traversal", async () => {
    const error = new RepositoryError("compatibility");
    const store = setup();
    await expect(loadFullTree({ getSnapshot: store.getSnapshot, loadDirectory() { throw error; } })).rejects.toBe(error);
  });

  it("rejects promptly after failure, detaches late rejections, and never starts a queued sibling", async () => {
    const a = deferred<DirectoryListing>();
    const b = deferred<DirectoryListing>();
    const calls: string[] = [];
    const progress: TraversalProgress[] = [];
    const store = setup((_repo, _ref, path) => {
      calls.push(path);
      return path === "" ? Promise.resolve(listing(path, ["a", "b", "c"].map((name) => entry(name, "directory"))))
        : path === "a" ? a.promise : b.promise;
    });
    const error = new RepositoryError("rate-limited", { status: 429 });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const traversal = loadFullTree(store, { concurrency: 2, signal: controller.signal, onProgress: (value) => progress.push(value) });
    const rejection = expect(traversal).rejects.toBe(error);
    await vi.waitFor(() => expect(calls).toEqual(["", "a", "b"]));
    a.reject(error);
    await vi.waitFor(() => expect(progress).toHaveLength(2));
    expect(progress[1]).toEqual({ loadedNodes: 3, queuedDirectories: 1, activeRequests: 1 });
    await rejection;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    b.reject(new RepositoryError("network"));
    await vi.waitFor(() => expect(store.getSnapshot().nodesByPath.b.error?.code).toBe("network"));
    expect(calls).toEqual(["", "a", "b"]);
    expect(progress).toHaveLength(2);
  });

  it.each(["signed-out", "forbidden"] as const)("preserves settled %s when auth clearing aborts the traversal signal", async (code) => {
    const response = deferred<DirectoryListing>();
    const controller = new AbortController();
    const progress: TraversalProgress[] = [];
    const store = setup(() => response.promise);
    store.subscribe(() => {
      if (store.getSnapshot().repo === null) controller.abort();
    });
    const error = new RepositoryError(code, { status: code === "signed-out" ? 401 : 403 });
    const traversal = loadFullTree(store, { signal: controller.signal, onProgress: (value) => progress.push(value) });
    const rejection = expect(traversal).rejects.toBe(error);
    await vi.waitFor(() => expect(store.getSnapshot().nodesByPath[""].loading).toBe(true));
    response.reject(error);
    await rejection;
    expect(controller.signal.aborted).toBe(true);
    expect(store.getSnapshot().nodesByPath).toEqual({});
    expect(progress).toEqual([]);
  });

  it.each(["rate-limited", "compatibility"] as const)("preserves settled %s when its error notification aborts", async (code) => {
    const response = deferred<DirectoryListing>();
    const controller = new AbortController();
    const store = setup(() => response.promise);
    store.subscribe(() => {
      if (store.getSnapshot().nodesByPath[""]?.error) controller.abort();
    });
    const error = new RepositoryError(code);
    const traversal = loadFullTree(store, { signal: controller.signal });
    const rejection = expect(traversal).rejects.toBe(error);
    await vi.waitFor(() => expect(store.getSnapshot().nodesByPath[""].loading).toBe(true));
    response.reject(error);
    await rejection;
    expect(controller.signal.aborted).toBe(true);
  });

  it.each(["signed-out", "forbidden"] as const)("preserves simultaneous %s despite progress abort after sibling cancellation", async (code) => {
    const a = deferred<DirectoryListing>();
    const b = deferred<DirectoryListing>();
    const controller = new AbortController();
    const progress: TraversalProgress[] = [];
    const store = setup((_repo, _ref, path) => path === "" ? Promise.resolve(listing(path, [entry("a", "directory"), entry("b", "directory")]))
      : path === "a" ? a.promise : b.promise);
    const error = new RepositoryError(code);
    const traversal = loadFullTree(store, { concurrency: 2, signal: controller.signal, onProgress: (value) => {
      progress.push(value);
      if (progress.length === 2) controller.abort();
    } });
    const rejection = expect(traversal).rejects.toBe(error);
    await vi.waitFor(() => expect(store.getSnapshot().nodesByPath.b.loading).toBe(true));
    a.resolve(listing("a"));
    b.reject(error);
    await rejection;
    expect(controller.signal.aborted).toBe(true);
    expect(progress).toHaveLength(2);
    expect(store.getSnapshot().nodesByPath).toEqual({});
  });

  it("retains the first observed fatal when multiple fatal siblings and progress abort coincide", async () => {
    const a = deferred<DirectoryListing>();
    const b = deferred<DirectoryListing>();
    const controller = new AbortController();
    const progress: TraversalProgress[] = [];
    const store = setup((_repo, _ref, path) => path === "" ? Promise.resolve(listing(path, [entry("a", "directory"), entry("b", "directory")]))
      : path === "a" ? a.promise : b.promise);
    const first = new RepositoryError("rate-limited");
    const traversal = loadFullTree(store, { concurrency: 2, signal: controller.signal, onProgress: (value) => {
      progress.push(value);
      if (progress.length === 2) controller.abort();
    } });
    const rejection = expect(traversal).rejects.toBe(first);
    await vi.waitFor(() => expect(store.getSnapshot().nodesByPath.b.loading).toBe(true));
    a.reject(first);
    b.reject(new RepositoryError("compatibility"));
    await rejection;
    expect(progress).toHaveLength(2);
  });

  it("does not publish a late success or traverse its children after fatal rejection", async () => {
    const a = deferred<DirectoryListing>();
    const b = deferred<DirectoryListing>();
    const calls: string[] = [];
    const progress: TraversalProgress[] = [];
    const store = setup((_repo, _ref, path) => {
      calls.push(path);
      return path === "" ? Promise.resolve(listing(path, [entry("a", "directory"), entry("b", "directory")]))
        : path === "a" ? a.promise : b.promise;
    });
    const error = new RepositoryError("compatibility");
    const traversal = loadFullTree(store, { concurrency: 2, onProgress: (value) => progress.push(value) });
    const rejection = expect(traversal).rejects.toBe(error);
    await vi.waitFor(() => expect(calls).toEqual(["", "a", "b"]));
    a.reject(error);
    await rejection;
    b.resolve(listing("b", [entry("b/child", "directory")]));
    await vi.waitFor(() => expect(store.getSnapshot().nodesByPath.b.loaded).toBe(true));
    expect(calls).toEqual(["", "a", "b"]);
    expect(progress).toHaveLength(2);
  });

  it.each([new RepositoryError("rate-limited"), new RepositoryError("compatibility"), new Error("synthetic fatal"), undefined])(
    "preserves a simultaneous fatal sibling when a progress callback aborts (%s)", async (error) => {
      const a = deferred<DirectoryListing>();
      const b = deferred<DirectoryListing>();
      const controller = new AbortController();
      const progress: TraversalProgress[] = [];
      const calls: string[] = [];
      const store = setup((_repo, _ref, path) => {
        calls.push(path);
        return path === "" ? Promise.resolve(listing(path, ["a", "b", "c"].map((name) => entry(name, "directory"))))
          : path === "a" ? a.promise : b.promise;
      });
      const traversal = loadFullTree(store, { concurrency: 2, signal: controller.signal, onProgress: (value) => {
        progress.push(value);
        if (progress.length === 2) controller.abort();
      } });
      const rejection = expect(traversal).rejects.toBe(error);
      await vi.waitFor(() => expect(calls).toEqual(["", "a", "b"]));
      a.resolve(listing("a", [entry("a/file")]));
      b.reject(error);
      await rejection;
      expect(controller.signal.aborted).toBe(true);
      expect(calls).toEqual(["", "a", "b"]);
      expect(progress).toHaveLength(2);
    },
  );

  it.each(["rate-limited", "compatibility", "network"] as const)("delivers %s without waiting for a never-settling sibling", async (code) => {
    const a = deferred<DirectoryListing>();
    const calls: string[] = [];
    const store = setup((_repo, _ref, path) => {
      calls.push(path);
      return path === "" ? Promise.resolve(listing(path, ["a", "b", "c"].map((name) => entry(name, "directory"))))
        : path === "a" ? a.promise : new Promise<DirectoryListing>(() => {});
    });
    const error = new RepositoryError(code);
    let outcome: { error: unknown } | undefined;
    const observation = loadFullTree(store, { concurrency: 2 }).then(
      () => { throw new Error("Unexpected traversal success"); },
      (received: unknown) => { outcome = { error: received }; },
    );
    await vi.waitFor(() => expect(calls).toEqual(["", "a", "b"]));
    a.reject(error);
    await vi.waitFor(() => expect(outcome?.error).toBe(error), { timeout: 200 });
    await observation;
    expect(calls).toEqual(["", "a", "b"]);
    expect(store.getSnapshot().nodesByPath.b.loading).toBe(true);
  });

  it("ignores a fatal result genuinely arriving after progress cancellation", async () => {
    const a = deferred<DirectoryListing>();
    const b = deferred<DirectoryListing>();
    const controller = new AbortController();
    const progress: TraversalProgress[] = [];
    const store = setup((_repo, _ref, path) => path === "" ? Promise.resolve(listing(path, [entry("a", "directory"), entry("b", "directory")]))
      : path === "a" ? a.promise : b.promise);
    const traversal = loadFullTree(store, { concurrency: 2, signal: controller.signal, onProgress: (value) => {
      progress.push(value);
      if (progress.length === 2) {
        controller.abort();
        b.reject(new RepositoryError("rate-limited"));
      }
    } });
    await vi.waitFor(() => expect(store.getSnapshot().nodesByPath.b.loading).toBe(true));
    a.resolve(listing("a"));
    await expect(traversal).resolves.toMatchObject({ cancelled: true });
    await vi.waitFor(() => expect(store.getSnapshot().nodesByPath.b.error?.code).toBe("rate-limited"));
    expect(progress).toHaveLength(2);
  });

  it.each(["signed-out", "forbidden"] as const)("preserves %s ahead of sibling cancellation and clears the real store", async (code) => {
    const a = deferred<DirectoryListing>();
    const b = deferred<DirectoryListing>();
    const store = setup((_repo, _ref, path) => path === "" ? Promise.resolve(listing(path, [entry("a", "directory"), entry("b", "directory")]))
      : path === "a" ? a.promise : b.promise);
    const error = new RepositoryError(code);
    const traversal = loadFullTree(store, { concurrency: 2 });
    const rejection = expect(traversal).rejects.toBe(error);
    await vi.waitFor(() => expect(store.getSnapshot().nodesByPath.b.loading).toBe(true));
    a.reject(error);
    await rejection;
    expect(store.getSnapshot().nodesByPath).toEqual({});
    b.resolve(listing("b", [entry("b/file")]));
    await Promise.resolve();
    expect(store.getSnapshot().nodesByPath).toEqual({});
  });

  it("observes late rejection after explicit cancellation without publishing more progress", async () => {
    const response = deferred<DirectoryListing>();
    const controller = new AbortController();
    const progress: TraversalProgress[] = [];
    const store = setup(() => response.promise);
    const traversal = loadFullTree(store, { signal: controller.signal, onProgress: (value) => progress.push(value) });
    await vi.waitFor(() => expect(store.getSnapshot().nodesByPath[""].loading).toBe(true));
    controller.abort();
    await traversal;
    response.reject(new RepositoryError("network"));
    await vi.waitFor(() => expect(store.getSnapshot().nodesByPath[""].error?.code).toBe("network"));
    expect(progress).toEqual([]);
  });

  it("cancels an inactive store without loading phantom root state", async () => {
    const store = setup();
    store.clearSensitiveData();
    await expect(loadFullTree(store)).resolves.toEqual({ loadedNodes: 0, truncated: false, cancelled: true });
    expect(store.getSnapshot().nodesByPath).toEqual({});
  });

  it("promptly cancels an abort-insensitive pending load, detaches its listener, and stops late progress", async () => {
    const response = deferred<DirectoryListing>();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const calls: string[] = [];
    const progress: TraversalProgress[] = [];
    const store = setup((_repo, _ref, path) => { calls.push(path); return response.promise; });
    const traversal = loadFullTree(store, { signal: controller.signal, onProgress: (value) => progress.push(value) });
    await vi.waitFor(() => expect(calls).toEqual([""]));
    controller.abort("synthetic reason");
    await expect(traversal).resolves.toEqual({ loadedNodes: 0, truncated: false, cancelled: true });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    response.resolve(listing("", [entry("dir", "directory")]));
    await vi.waitFor(() => expect(store.getSnapshot().nodesByPath[""].loaded).toBe(true));
    expect(progress).toEqual([]);
    expect(calls).toEqual([""]);
  });

  it("honors cancellation from a progress callback before dispatching children", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const store = setup(async (_repo, _ref, path) => { calls.push(path); return listing(path, [entry("a", "directory")]); });
    await expect(loadFullTree(store, { signal: controller.signal, onProgress: () => controller.abort() })).resolves.toEqual({
      loadedNodes: 1, truncated: false, cancelled: true,
    });
    expect(calls).toEqual([""]);
  });

  it("cancels on store session replacement without traversing the replacement tree", async () => {
    const response = deferred<DirectoryListing>();
    const store = setup(() => response.promise);
    const traversal = loadFullTree(store);
    await vi.waitFor(() => expect(store.getSnapshot().nodesByPath[""].loading).toBe(true));
    store.startSession("synthetic/other", "other");
    await expect(traversal).resolves.toMatchObject({ cancelled: true });
    response.resolve(listing("", [entry("old", "directory")]));
    await Promise.resolve();
    expect(store.getSnapshot().nodesByPath.old).toBeUndefined();
  });

  it("stops scheduling and propagates a throwing progress observer", async () => {
    const error = new Error("synthetic observer failure");
    const store = setup(async () => listing("", [entry("a", "directory")]));
    await expect(loadFullTree(store, { onProgress: () => { throw error; } })).rejects.toBe(error);
    expect(store.getSnapshot().nodesByPath.a.loaded).toBe(false);
  });

  it("retains no traversal state between calls and resumes from the shared loaded cache", async () => {
    const calls: string[] = [];
    const store = setup(async (_repo, _ref, path) => {
      calls.push(path);
      return path === "" ? listing(path, [entry("a", "directory")]) : listing(path, [entry("a/file")]);
    });
    await expect(loadFullTree(store, { maxNodes: 1 })).resolves.toMatchObject({ loadedNodes: 1, truncated: true });
    await expect(loadFullTree(store)).resolves.toEqual({ loadedNodes: 2, truncated: false, cancelled: false });
    expect(calls).toEqual(["", "a"]);
  });
});
