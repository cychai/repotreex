import { afterEach, describe, expect, it, vi } from "vitest";
import { createBridgeClient } from "../src/content/bridge-client";
import { createSessionProvider, type DirectoryListing, type RepositoryProvider } from "../src/content/provider";
import { createTreeStore, type TreeSnapshot, type TreeStore } from "../src/content/tree-store";
import { RepositoryError } from "../src/shared/errors";
import { BRIDGE_REQUEST_EVENT, BRIDGE_RESPONSE_EVENT, type BridgeRequest } from "../src/shared/protocol";
import { treeFixture } from "./fixtures/repository";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const root: DirectoryListing = {
  path: "", sha: "root-sha", entries: [
    { kind: "file", name: "README.md", path: "README.md", sha: "readme-sha" },
    { kind: "directory", name: "src", path: "src", sha: "src-sha" },
    { kind: "directory", name: "docs", path: "docs", sha: "docs-sha" },
    { kind: "link", name: "shortcut", path: "shortcut", sha: "link-sha" },
    { kind: "submodule", name: "vendor", path: "vendor", sha: "module-sha" },
  ],
};
const source: DirectoryListing = {
  path: "src", sha: "src-sha", entries: [
    { kind: "file", name: "index.ts", path: "src/index.ts", sha: "index-sha" },
    { kind: "directory", name: "nested", path: "src/nested", sha: "nested-sha" },
  ],
};
const nested: DirectoryListing = {
  path: "src/nested", sha: "nested-sha", entries: [
    { kind: "file", name: "a.ts", path: "src/nested/a.ts", sha: "a-sha" },
  ],
};
const stores: TreeStore[] = [];

function setup(listDirectory: RepositoryProvider["listDirectory"] = async (_repo, _ref, path) => {
  if (path === "") return root;
  if (path === "src") return source;
  if (path === "src/nested") return nested;
  return { path, sha: "empty-sha", entries: [] };
}) {
  const provider: RepositoryProvider = {
    getHead: vi.fn().mockResolvedValue("main"),
    listDirectory: vi.fn(listDirectory),
    listBranches: vi.fn().mockResolvedValue([]),
    listTags: vi.fn().mockResolvedValue([]),
    dispose: vi.fn(),
  };
  const store = createTreeStore(provider);
  stores.push(store);
  return { store, provider };
}

function expectCleared(store: TreeStore) {
  expect(store.getSnapshot()).toEqual({
    repo: null, ref: null, nodesByPath: {}, visibleNodes: [], expandedPaths: [], selectedPath: null,
  });
}

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.restoreAllMocks();
});

describe("tree store", () => {
  it("starts empty and represents the hidden root using the empty path", () => {
    const { store, provider } = setup();
    expectCleared(store);
    store.startSession("acme/team/repo", "release/v1");
    expect(store.getSnapshot()).toMatchObject({
      repo: "acme/team/repo", ref: "release/v1", visibleNodes: [],
      nodesByPath: { "": { kind: "directory", path: "", parentPath: null, depth: 0, loaded: false } },
    });
    expect(provider.listDirectory).not.toHaveBeenCalled();
  });

  it("sorts directories first and names naturally with stable case-insensitive ties", async () => {
    const listing: DirectoryListing = { path: "", sha: "root-sha", entries: [
      { kind: "file", name: "z.ts", path: "z.ts", sha: "z-sha" },
      { kind: "directory", name: "dir10", path: "dir10", sha: "dir10-sha" },
      { kind: "file", name: "file10.ts", path: "file10.ts", sha: "10-sha" },
      { kind: "file", name: "file2.ts", path: "file2.ts", sha: "2-sha" },
      { kind: "file", name: "A.ts", path: "A.ts", sha: "upper-sha" },
      { kind: "file", name: "a.ts", path: "a.ts", sha: "lower-sha" },
      { kind: "directory", name: "dir2", path: "dir2", sha: "dir2-sha" },
    ] };
    const { store } = setup(async () => listing);
    store.startSession("acme/repo", "main");
    await store.loadDirectory("");
    expect(store.getSnapshot().visibleNodes.map((node) => node.path)).toEqual([
      "dir2", "dir10", "A.ts", "a.ts", "file2.ts", "file10.ts", "z.ts",
    ]);
    expect(store.getSnapshot().nodesByPath[""].sha).toBe("root-sha");
    expect(listing.entries.map((entry) => entry.path)).toEqual([
      "z.ts", "dir10", "file10.ts", "file2.ts", "A.ts", "a.ts", "dir2",
    ]);
  });

  it("treats an empty loaded directory as success rather than an error or a cache miss", async () => {
    const { store, provider } = setup(async () => ({ path: "", sha: "empty-sha", entries: [] }));
    store.startSession("acme/repo", "main");
    await store.loadDirectory("");
    await store.loadDirectory("");
    expect(store.getSnapshot().nodesByPath[""]).toMatchObject({ loaded: true, loading: false, error: null, childPaths: [] });
    expect(store.getSnapshot().visibleNodes).toEqual([]);
    expect(provider.listDirectory).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent requests and forwards the exact context and an AbortSignal", async () => {
    const response = deferred<DirectoryListing>();
    const { store, provider } = setup(() => response.promise);
    store.startSession("acme/team/repo", "release/v1");
    const first = store.loadDirectory("");
    const second = store.loadDirectory("");
    expect(first).toBe(second);
    expect(store.getSnapshot().nodesByPath[""]).toMatchObject({ loading: true, loaded: false, error: null });
    await Promise.resolve();
    expect(provider.listDirectory).toHaveBeenCalledExactlyOnceWith("acme/team/repo", "release/v1", "", expect.any(AbortSignal));
    response.resolve(root);
    await first;
    expect(store.getSnapshot().nodesByPath[""]).toMatchObject({ loading: false, loaded: true });
  });

  it("loads different directories independently", async () => {
    const sourceResponse = deferred<DirectoryListing>();
    const docsResponse = deferred<DirectoryListing>();
    const { store } = setup((_repo, _ref, path) => path === "" ? Promise.resolve(root)
      : path === "src" ? sourceResponse.promise : docsResponse.promise);
    store.startSession("acme/repo", "main");
    await store.loadDirectory("");
    const sourceLoad = store.loadDirectory("src");
    const docsLoad = store.loadDirectory("docs");
    expect(sourceLoad).not.toBe(docsLoad);
    sourceResponse.resolve(source);
    await sourceLoad;
    expect(store.getSnapshot().nodesByPath.docs.loading).toBe(true);
    docsResponse.resolve({ path: "docs", sha: "docs-sha", entries: [] });
    await docsLoad;
    expect(store.getSnapshot().nodesByPath.docs.loaded).toBe(true);
  });

  it("flattens nested expansions in depth-first order and keeps collapsed children cached", async () => {
    const { store, provider } = setup();
    store.startSession("acme/repo", "main");
    await store.loadDirectory("");
    await store.toggleDirectory("src");
    await store.toggleDirectory("src/nested");
    expect(store.getSnapshot().visibleNodes.map((node) => [node.path, node.depth])).toEqual([
      ["docs", 1], ["src", 1], ["src/nested", 2], ["src/nested/a.ts", 3], ["src/index.ts", 2],
      ["README.md", 1], ["shortcut", 1], ["vendor", 1],
    ]);
    await store.toggleDirectory("src");
    expect(store.getSnapshot().visibleNodes.map((node) => node.path)).toEqual(["docs", "src", "README.md", "shortcut", "vendor"]);
    expect(store.getSnapshot().nodesByPath["src/nested/a.ts"].parentPath).toBe("src/nested");
    await store.toggleDirectory("src");
    expect(store.getSnapshot().visibleNodes.map((node) => node.path)).toContain("src/nested/a.ts");
    expect(provider.listDirectory).toHaveBeenCalledTimes(3);
  });

  it("loads directories for indexing without expanding them", async () => {
    const { store } = setup();
    store.startSession("acme/repo", "main");
    await store.loadDirectory("");
    await store.loadDirectory("src");
    expect(store.getSnapshot().nodesByPath["src/index.ts"].path).toBe("src/index.ts");
    expect(store.getSnapshot().visibleNodes.map((node) => node.path)).not.toContain("src/index.ts");
    expect(store.getSnapshot().expandedPaths).toEqual([]);
  });

  it("keeps a collapse made while loading instead of re-expanding on settlement", async () => {
    const response = deferred<DirectoryListing>();
    const { store } = setup((_repo, _ref, path) => path === "" ? Promise.resolve(root) : response.promise);
    store.startSession("acme/repo", "main");
    await store.loadDirectory("");
    const load = store.toggleDirectory("src");
    await store.toggleDirectory("src");
    response.resolve(source);
    await load;
    expect(store.getSnapshot().nodesByPath.src).toMatchObject({ loaded: true, expanded: false });
    expect(store.getSnapshot().visibleNodes.map((node) => node.path)).not.toContain("src/index.ts");
  });

  it("selects exactly one known path, preserves hidden selection, and supports clearing it", async () => {
    const { store } = setup();
    store.startSession("acme/repo", "main");
    await store.loadDirectory("");
    await store.toggleDirectory("src");
    store.selectPath("README.md");
    store.selectPath("src/index.ts");
    await store.toggleDirectory("src");
    expect(store.getSnapshot().selectedPath).toBe("src/index.ts");
    expect(store.getSnapshot().nodesByPath["README.md"].selected).toBe(false);
    expect(store.getSnapshot().nodesByPath["src/index.ts"].selected).toBe(true);
    store.selectPath(null);
    expect(store.getSnapshot().selectedPath).toBeNull();
    expect(store.getSnapshot().nodesByPath["src/index.ts"].selected).toBe(false);
  });

  it("rejects unknown paths without creating phantom nodes or changing selection", async () => {
    const { store, provider } = setup();
    store.startSession("acme/repo", "main");
    await store.loadDirectory("");
    store.selectPath("README.md");
    const snapshot = store.getSnapshot();
    await expect(store.loadDirectory("missing")).rejects.toMatchObject({ code: "not-found" });
    await expect(store.toggleDirectory("missing")).rejects.toMatchObject({ code: "not-found" });
    expect(() => store.selectPath("missing")).toThrow(RepositoryError);
    expect(store.getSnapshot()).toBe(snapshot);
    expect(provider.listDirectory).toHaveBeenCalledTimes(1);
  });

  it.each(["README.md", "shortcut", "vendor"])("does not traverse a non-directory %s", async (path) => {
    const { store, provider } = setup();
    store.startSession("acme/repo", "main");
    await store.loadDirectory("");
    await expect(store.loadDirectory(path)).rejects.toMatchObject({ code: "compatibility" });
    await expect(store.toggleDirectory(path)).rejects.toMatchObject({ code: "compatibility" });
    expect(provider.listDirectory).toHaveBeenCalledTimes(1);
  });

  it.each([
    { code: "not-found", status: 404 },
    { code: "rate-limited", status: 429, retryAfter: 30 },
    { code: "server", status: 503 },
    { code: "network" },
    { code: "compatibility" },
  ] as const)("preserves a distinguishable $code row error and permits a successful retry", async (expectedError) => {
    const error = new RepositoryError(expectedError.code, expectedError);
    let fail = true;
    const { store } = setup(async (_repo, _ref, path) => {
      if (path === "") return root;
      if (path === "docs") return { path, sha: "docs-sha", entries: [] };
      if (fail) throw error;
      return source;
    });
    store.startSession("acme/repo", "main");
    await store.loadDirectory("");
    await store.loadDirectory("docs");
    store.selectPath("README.md");
    await expect(store.toggleDirectory("src")).rejects.toBe(error);
    expect(store.getSnapshot().nodesByPath.src).toMatchObject({ loading: false, loaded: false, expanded: true, error: expectedError });
    expect(store.getSnapshot().nodesByPath.docs.loaded).toBe(true);
    expect(store.getSnapshot().selectedPath).toBe("README.md");
    fail = false;
    const retry = store.loadDirectory("src");
    expect(store.getSnapshot().nodesByPath.src).toMatchObject({ loading: true, error: null });
    await retry;
    expect(store.getSnapshot().nodesByPath.src).toMatchObject({ loaded: true, loading: false, error: null });
    expect(store.getSnapshot().visibleNodes.map((node) => node.path)).toContain("src/index.ts");
  });

  it("stores only code/status/retryAfter rather than provider error objects or arbitrary metadata", async () => {
    const error = Object.assign(new RepositoryError("rate-limited", { status: 429, retryAfter: 12 }), {
      body: "synthetic-body", repo: "synthetic-repo", path: "synthetic-path",
    });
    const { store } = setup(async () => { throw error; });
    store.startSession("acme/repo", "main");
    await expect(store.loadDirectory("")).rejects.toBe(error);
    expect(store.getSnapshot().nodesByPath[""].error).toEqual({ code: "rate-limited", status: 429, retryAfter: 12 });
  });

  it("surfaces an unexpected provider exception without converting it into an empty success", async () => {
    const error = new Error("synthetic unexpected provider failure");
    const { store } = setup(async () => { throw error; });
    store.startSession("acme/repo", "main");
    await expect(store.loadDirectory("")).rejects.toBe(error);
    expect(store.getSnapshot().nodesByPath[""]).toMatchObject({ loaded: false, loading: false, error: { code: "compatibility" } });
  });

  it("does not present normal cancellation as a retryable row error", async () => {
    const { store } = setup(async () => { throw new RepositoryError("cancelled"); });
    store.startSession("acme/repo", "main");
    await expect(store.loadDirectory("")).rejects.toMatchObject({ code: "cancelled" });
    expect(store.getSnapshot().nodesByPath[""]).toMatchObject({ loaded: false, loading: false, error: null });
  });

  it.each(["signed-out", "forbidden"] as const)("clears every sensitive field and aborts other loads before rethrowing %s", async (code) => {
    const sourceResponse = deferred<DirectoryListing>();
    const docsResponse = deferred<DirectoryListing>();
    const signals: AbortSignal[] = [];
    const { store } = setup((_repo, _ref, path, signal) => {
      if (signal) signals.push(signal);
      return path === "" ? Promise.resolve(root) : path === "src" ? sourceResponse.promise : docsResponse.promise;
    });
    store.startSession("private/team/repo", "secret-branch");
    await store.loadDirectory("");
    store.selectPath("README.md");
    const sourceLoad = store.toggleDirectory("src");
    const cancelled = expect(sourceLoad).rejects.toMatchObject({ code: "cancelled" });
    const docsLoad = store.toggleDirectory("docs");
    const error = new RepositoryError(code, { status: code === "signed-out" ? 401 : 403 });
    const failed = expect(docsLoad).rejects.toBe(error);
    await Promise.resolve();
    docsResponse.reject(error);
    await failed;
    await cancelled;
    expectCleared(store);
    expect(signals.slice(1).every((signal) => signal.aborted)).toBe(true);
    sourceResponse.resolve(source);
    await Promise.resolve();
    expectCleared(store);
  });

  it.each([
    ["acme/other", "main"], ["acme/repo", "release/v1"], ["acme/repo", "main"],
  ])("replaces sessions even for identical context (%s, %s) and rejects late success", async (repo, ref) => {
    const oldResponse = deferred<DirectoryListing>();
    let oldSignal: AbortSignal | undefined;
    let calls = 0;
    const { store } = setup((_repo, _ref, _path, signal) => {
      if (calls++ === 0) { oldSignal = signal; return oldResponse.promise; }
      return Promise.resolve({ path: "", sha: "new-sha", entries: [] });
    });
    store.startSession("acme/repo", "main");
    const oldLoad = store.loadDirectory("");
    const cancelled = expect(oldLoad).rejects.toMatchObject({ code: "cancelled" });
    await Promise.resolve();
    store.startSession(repo, ref);
    await cancelled;
    expect(oldSignal?.aborted).toBe(true);
    await store.loadDirectory("");
    const current = store.getSnapshot();
    const listener = vi.fn();
    store.subscribe(listener);
    oldResponse.resolve(root);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot()).toBe(current);
    expect(current).toMatchObject({ repo, ref, visibleNodes: [], nodesByPath: { "": { sha: "new-sha" } } });
    expect(listener).not.toHaveBeenCalled();
  });

  it.each(["signed-out", "forbidden", "network"] as const)("does not let an old %s failure clear or publish into a replacement session", async (code) => {
    const oldResponse = deferred<DirectoryListing>();
    let first = true;
    const { store } = setup(() => {
      if (first) { first = false; return oldResponse.promise; }
      return Promise.resolve(root);
    });
    store.startSession("acme/old", "old-ref");
    const oldLoad = store.loadDirectory("");
    const cancelled = expect(oldLoad).rejects.toMatchObject({ code: "cancelled" });
    await Promise.resolve();
    store.startSession("acme/new", "new-ref");
    await store.loadDirectory("");
    await cancelled;
    const current = store.getSnapshot();
    const listener = vi.fn();
    store.subscribe(listener);
    oldResponse.reject(new RepositoryError(code));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot()).toBe(current);
    expect(listener).not.toHaveBeenCalled();
  });

  it("clears loaded nodes, child arrays, expansion, selection, and errors before starting another session", async () => {
    const { store } = setup(async (_repo, _ref, path) => {
      if (path === "docs") throw new RepositoryError("network");
      return path === "" ? root : source;
    });
    store.startSession("acme/old", "old-ref");
    await store.loadDirectory("");
    await store.toggleDirectory("src");
    store.selectPath("src/index.ts");
    await expect(store.toggleDirectory("docs")).rejects.toMatchObject({ code: "network" });
    store.startSession("acme/new", "new-ref");
    expect(store.getSnapshot()).toMatchObject({ repo: "acme/new", ref: "new-ref", expandedPaths: [], selectedPath: null, visibleNodes: [] });
    expect(Object.keys(store.getSnapshot().nodesByPath)).toEqual([""]);
    expect(store.getSnapshot().nodesByPath[""]).toMatchObject({ childPaths: [], error: null, loaded: false });
  });

  it("explicit clearing promptly cancels a provider that ignores abort and permits a fresh session", async () => {
    const response = deferred<DirectoryListing>();
    const { store, provider } = setup(() => response.promise);
    store.startSession("acme/repo", "main");
    const load = store.loadDirectory("");
    const cancelled = expect(load).rejects.toMatchObject({ code: "cancelled" });
    await Promise.resolve();
    store.clearSensitiveData();
    await cancelled;
    expectCleared(store);
    expect(provider.dispose).not.toHaveBeenCalled();
    store.startSession("acme/new", "new-ref");
    const current = store.getSnapshot();
    response.resolve(root);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot()).toBe(current);
  });

  it("does not let old finalization remove a new pending request for the same path", async () => {
    const oldResponse = deferred<DirectoryListing>();
    const newResponse = deferred<DirectoryListing>();
    let first = true;
    const { store, provider } = setup(() => {
      if (first) { first = false; return oldResponse.promise; }
      return newResponse.promise;
    });
    store.startSession("acme/old", "main");
    const oldLoad = store.loadDirectory("");
    const cancelled = expect(oldLoad).rejects.toMatchObject({ code: "cancelled" });
    await Promise.resolve();
    store.startSession("acme/new", "main");
    const newLoad = store.loadDirectory("");
    await cancelled;
    oldResponse.resolve(root);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.loadDirectory("")).toBe(newLoad);
    expect(provider.listDirectory).toHaveBeenCalledTimes(2);
    newResponse.resolve(root);
    await newLoad;
  });

  it("freezes every snapshot surface and copies provider entries", async () => {
    const listing: DirectoryListing = { path: "", sha: "root-sha", entries: [
      { kind: "directory", name: "src", path: "src", sha: "src-sha" },
    ] };
    const { store } = setup(async (_repo, _ref, path) => path === "" ? listing : source);
    store.startSession("acme/repo", "main");
    await store.loadDirectory("");
    const snapshot = store.getSnapshot();
    const node = snapshot.nodesByPath.src;
    for (const value of [snapshot, snapshot.nodesByPath, snapshot.visibleNodes, snapshot.expandedPaths, node, node.childPaths]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(Reflect.set(snapshot, "repo", "changed")).toBe(false);
    expect(Reflect.set(snapshot.nodesByPath, "src", null)).toBe(false);
    expect(Reflect.set(node, "name", "changed")).toBe(false);
    expect(Reflect.set(snapshot.nodesByPath[""].childPaths, "0", "changed")).toBe(false);
    listing.entries[0].name = "provider-mutated";
    listing.entries.length = 0;
    expect(store.getSnapshot().nodesByPath.src.name).toBe("src");
    expect(store.getSnapshot()).toBe(snapshot);
    await store.toggleDirectory("src");
    const expandedSnapshot = store.getSnapshot();
    expect(expandedSnapshot).not.toBe(snapshot);
    expect(expandedSnapshot.nodesByPath.src).toMatchObject({
      path: "src", name: "src", sha: "src-sha", parentPath: "", depth: 1,
      loaded: true, expanded: true, childPaths: ["src/nested", "src/index.ts"],
    });
    expect(expandedSnapshot.nodesByPath["src/index.ts"]).toMatchObject({ parentPath: "src", depth: 2 });
    expect(expandedSnapshot.visibleNodes.map((entry) => entry.path)).toEqual(["src", "src/nested", "src/index.ts"]);
    expect(snapshot.nodesByPath.src).toMatchObject({ expanded: false, loaded: false, childPaths: [] });
    expect(snapshot.expandedPaths).toEqual([]);
    expect(snapshot.visibleNodes.map((entry) => entry.path)).toEqual(["src"]);
    expect(Object.hasOwn(snapshot.nodesByPath, "src/index.ts")).toBe(false);
  });

  it("freezes detached error snapshots without freezing or sharing the thrown error", async () => {
    const error = new RepositoryError("network");
    const { store } = setup(async () => { throw error; });
    store.startSession("acme/repo", "main");
    await expect(store.loadDirectory("")).rejects.toBe(error);
    const snapshotError = store.getSnapshot().nodesByPath[""].error;
    expect(snapshotError).not.toBeNull();
    expect(Object.isFrozen(snapshotError)).toBe(true);
    expect(Object.isFrozen(error)).toBe(false);
    Object.assign(error, { code: "server" });
    expect(snapshotError).toEqual({ code: "network" });
  });

  it("indexes prototype-like repository paths as ordinary own keys", async () => {
    const { store } = setup(async () => ({ path: "", sha: "root-sha", entries: [
      { kind: "file", name: "__proto__", path: "__proto__", sha: "proto-sha" },
      { kind: "file", name: "constructor", path: "constructor", sha: "constructor-sha" },
      { kind: "file", name: "toString", path: "toString", sha: "string-sha" },
    ] }));
    store.startSession("acme/repo", "main");
    await store.loadDirectory("");
    for (const path of ["__proto__", "constructor", "toString"]) {
      expect(Object.hasOwn(store.getSnapshot().nodesByPath, path)).toBe(true);
      expect(store.getSnapshot().nodesByPath[path].path).toBe(path);
      store.selectPath(path);
      expect(store.getSnapshot().selectedPath).toBe(path);
    }
    store.clearSensitiveData();
    expectCleared(store);
  });

  it("publishes committed loading/success/selection/clear states and supports unsubscribe", async () => {
    const { store } = setup();
    const states: string[] = [];
    const unsubscribe = store.subscribe(() => {
      const snapshot = store.getSnapshot();
      states.push(snapshot.repo === null ? "cleared" : snapshot.selectedPath ? "selected"
        : snapshot.nodesByPath[""].loading ? "loading" : snapshot.nodesByPath[""].loaded ? "loaded" : "started");
    });
    store.startSession("acme/repo", "main");
    await store.loadDirectory("");
    store.selectPath("README.md");
    store.clearSensitiveData();
    expect(states).toEqual(["cleared", "started", "loading", "loaded", "selected", "cleared"]);
    unsubscribe();
    unsubscribe();
    store.startSession("acme/new", "main");
    expect(states).toHaveLength(6);
  });

  it("does not dispatch an old request when a loading subscriber replaces the session", async () => {
    const { store, provider } = setup();
    store.startSession("acme/old", "main");
    store.subscribe(() => {
      if (store.getSnapshot().repo === "acme/old" && store.getSnapshot().nodesByPath[""].loading) {
        store.startSession("acme/new", "new-ref");
      }
    });
    await expect(store.loadDirectory("")).rejects.toMatchObject({ code: "cancelled" });
    expect(provider.listDirectory).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toMatchObject({ repo: "acme/new", ref: "new-ref", visibleNodes: [] });
  });

  it("allows a failure subscriber to retry without reusing the already-rejected request", async () => {
    let first = true;
    const { store, provider } = setup(async () => {
      if (first) { first = false; throw new RepositoryError("network"); }
      return root;
    });
    store.startSession("acme/repo", "main");
    let retry: Promise<void> | undefined;
    store.subscribe(() => {
      if (store.getSnapshot().nodesByPath[""]?.error) retry = store.loadDirectory("");
    });
    await expect(store.loadDirectory("")).rejects.toMatchObject({ code: "network" });
    await retry;
    expect(provider.listDirectory).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().nodesByPath[""]).toMatchObject({ loaded: true, error: null });
  });

  it("rejects a successful load invalidated by its publication subscriber", async () => {
    const { store } = setup();
    store.startSession("acme/repo", "main");
    store.subscribe(() => {
      if (store.getSnapshot().nodesByPath[""]?.loaded) store.clearSensitiveData();
    });
    await expect(store.loadDirectory("")).rejects.toMatchObject({ code: "cancelled" });
    expectCleared(store);
  });

  it("does not overwrite a session started reentrantly during the cleared notification", () => {
    const { store } = setup();
    store.startSession("acme/old", "main");
    let replace = true;
    store.subscribe(() => {
      if (replace && store.getSnapshot().repo === null) {
        replace = false;
        store.startSession("acme/newest", "newest-ref");
      }
    });
    expect(() => store.startSession("acme/superseded", "old-ref")).toThrow(RepositoryError);
    expect(store.getSnapshot()).toMatchObject({ repo: "acme/newest", ref: "newest-ref" });
  });

  it("disposes once, promptly aborts pending operations, clears state, and removes subscribers", async () => {
    const response = deferred<DirectoryListing>();
    let signal: AbortSignal | undefined;
    const { store, provider } = setup((_repo, _ref, _path, requestSignal) => { signal = requestSignal; return response.promise; });
    store.startSession("acme/repo", "main");
    const load = store.loadDirectory("");
    const cancelled = expect(load).rejects.toMatchObject({ code: "cancelled" });
    await Promise.resolve();
    const listener = vi.fn();
    store.subscribe(listener);
    store.dispose();
    await cancelled;
    expect(signal?.aborted).toBe(true);
    expectCleared(store);
    expect(listener).toHaveBeenCalledTimes(1);
    store.dispose();
    store.clearSensitiveData();
    response.resolve(root);
    await Promise.resolve();
    await Promise.resolve();
    expectCleared(store);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(provider.dispose).toHaveBeenCalledTimes(1);
  });

  it("prevents calls before a session or after teardown from reviving sensitive data", async () => {
    const { store, provider } = setup();
    await expect(store.loadDirectory("")).rejects.toMatchObject({ code: "cancelled" });
    store.dispose();
    expect(() => store.startSession("acme/repo", "main")).toThrow(RepositoryError);
    expect(() => store.selectPath("README.md")).toThrow(RepositoryError);
    expect(() => store.subscribe(() => undefined)).toThrow(RepositoryError);
    await expect(store.loadDirectory("")).rejects.toMatchObject({ code: "cancelled" });
    await expect(store.toggleDirectory("src")).rejects.toMatchObject({ code: "cancelled" });
    expectCleared(store);
    expect(provider.listDirectory).not.toHaveBeenCalled();
  });

  it("makes disposal fail closed even if a subscriber throws", () => {
    const { store, provider } = setup();
    store.startSession("acme/repo", "main");
    const error = new Error("synthetic subscriber failure");
    store.subscribe(() => { throw error; });
    expect(() => store.dispose()).toThrow(error);
    expectCleared(store);
    expect(provider.dispose).toHaveBeenCalledTimes(1);
    expect(() => store.startSession("acme/repo", "main")).toThrow(RepositoryError);
    store.dispose();
  });

  it.each(["clear", "dispose"] as const)("notifies every consumer before propagating failures during %s", async (action) => {
    const response = deferred<DirectoryListing>();
    let pendingSignal: AbortSignal | undefined;
    const { store, provider } = setup((_repo, _ref, path, signal) => {
      if (path === "") return Promise.resolve(root);
      pendingSignal = signal;
      return response.promise;
    });
    store.startSession("acme/repo", "main");
    await store.loadDirectory("");
    store.selectPath("README.md");
    const load = store.toggleDirectory("src");
    const cancelled = expect(load).rejects.toMatchObject({ code: "cancelled" });
    await Promise.resolve();
    let panelSnapshot: TreeSnapshot | null = store.getSnapshot();
    const panel = document.createElement("div");
    panel.textContent = panelSnapshot.visibleNodes.map((node) => node.path).join("\n");
    const events: string[] = [];
    const firstError = new Error("synthetic first notification failure");
    const secondError = new Error("synthetic second notification failure");
    const unsubscribeFirst = store.subscribe(() => {
      events.push("first");
      throw firstError;
    });
    const unsubscribeSecond = store.subscribe(() => {
      events.push("second");
      throw secondError;
    });
    store.subscribe(() => {
      events.push("panel");
      if (store.getSnapshot().repo === null) {
        panelSnapshot = null;
        panel.replaceChildren();
      }
    });
    store.subscribe(() => {
      events.push("last");
      expectCleared(store);
      expect(pendingSignal?.aborted).toBe(true);
    });
    let thrown: unknown;
    try {
      if (action === "clear") store.clearSensitiveData();
      else store.dispose();
    } catch (error) {
      thrown = error;
    } finally {
      unsubscribeFirst();
      unsubscribeSecond();
    }
    await cancelled;
    expect(events).toEqual(["first", "second", "panel", "last"]);
    expect(thrown).toBeInstanceOf(AggregateError);
    if (!(thrown instanceof AggregateError)) throw new Error("expected notification aggregate");
    expect(thrown.errors).toEqual([firstError, secondError]);
    expect(panelSnapshot).toBeNull();
    expect(panel.textContent).toBe("");
    expectCleared(store);
    expect(provider.dispose).toHaveBeenCalledTimes(action === "dispose" ? 1 : 0);
    if (action === "dispose") {
      store.dispose();
      store.clearSensitiveData();
      expect(events).toHaveLength(4);
      expect(() => store.startSession("acme/new", "main")).toThrow(RepositoryError);
    }
    response.resolve(source);
    await Promise.resolve();
    await Promise.resolve();
    expectCleared(store);
  });

  it.each(["signed-out", "forbidden"] as const)("fans out auth clearing despite throwing subscribers and preserves %s rejection", async (code) => {
    const sourceResponse = deferred<DirectoryListing>();
    const docsResponse = deferred<DirectoryListing>();
    const signals: AbortSignal[] = [];
    const { store } = setup((_repo, _ref, path, signal) => {
      if (signal) signals.push(signal);
      return path === "" ? Promise.resolve(root) : path === "src" ? sourceResponse.promise : docsResponse.promise;
    });
    store.startSession("acme/repo", "main");
    await store.loadDirectory("");
    store.selectPath("README.md");
    const pendingLoad = store.toggleDirectory("src");
    const cancelled = expect(pendingLoad).rejects.toMatchObject({ code: "cancelled" });
    const authLoad = store.toggleDirectory("docs");
    await Promise.resolve();
    let panelSnapshot: TreeSnapshot | null = store.getSnapshot();
    const panel = document.createElement("div");
    panel.textContent = "README.md";
    const events: string[] = [];
    const firstError = new Error("synthetic first auth notification failure");
    const secondError = new Error("synthetic second auth notification failure");
    const unsubscribeFirst = store.subscribe(() => { events.push("first"); throw firstError; });
    const unsubscribeSecond = store.subscribe(() => { events.push("second"); throw secondError; });
    store.subscribe(() => {
      events.push("panel");
      if (store.getSnapshot().repo === null) {
        panelSnapshot = null;
        panel.replaceChildren();
      }
    });
    store.subscribe(() => { events.push("last"); });
    const authError = new RepositoryError(code, { status: code === "signed-out" ? 401 : 403 });
    const failed = expect(authLoad).rejects.toBe(authError);
    try {
      docsResponse.reject(authError);
      await failed;
      await cancelled;
      expect(events).toEqual(["first", "second", "panel", "last"]);
      expect(panelSnapshot).toBeNull();
      expect(panel.textContent).toBe("");
      expect(signals.slice(1).every((signal) => signal.aborted)).toBe(true);
      expectCleared(store);
      sourceResponse.resolve(source);
      await Promise.resolve();
      await Promise.resolve();
      expect(events).toHaveLength(4);
      expectCleared(store);
    } finally {
      unsubscribeFirst();
      unsubscribeSecond();
    }
  });

  it("fans out after a subscriber throws undefined and propagates that exact failure", () => {
    const { store } = setup();
    store.startSession("acme/repo", "main");
    let notified = false;
    let caught = false;
    const unsubscribe = store.subscribe(() => { throw undefined; });
    store.subscribe(() => { notified = true; });
    try {
      store.clearSensitiveData();
    } catch (error) {
      caught = true;
      expect(error).toBeUndefined();
    } finally {
      unsubscribe();
    }
    expect(caught).toBe(true);
    expect(notified).toBe(true);
    expectCleared(store);
  });

  it("retains both notification and provider disposal failures after fan-out and cleanup", () => {
    const { store, provider } = setup();
    store.startSession("acme/repo", "main");
    const notificationError = new Error("synthetic disposal notification failure");
    const disposalError = new Error("synthetic provider disposal failure");
    const events: string[] = [];
    store.subscribe(() => { events.push("first"); throw notificationError; });
    store.subscribe(() => { events.push("last"); expectCleared(store); });
    vi.mocked(provider.dispose).mockImplementation(() => { events.push("provider"); throw disposalError; });
    let thrown: unknown;
    try {
      store.dispose();
    } catch (error) {
      thrown = error;
    }
    expect(events).toEqual(["first", "last", "provider"]);
    expect(thrown).toBeInstanceOf(AggregateError);
    if (!(thrown instanceof AggregateError)) throw new Error("expected disposal aggregate");
    expect(thrown.errors).toEqual([notificationError, disposalError]);
    store.dispose();
    store.clearSensitiveData();
    expect(events).toHaveLength(3);
    expect(provider.dispose).toHaveBeenCalledTimes(1);
    expect(() => store.startSession("acme/new", "main")).toThrow(RepositoryError);
  });

  it("fans out a directory error while preserving the original provider rejection", async () => {
    const error = new RepositoryError("network");
    const { store } = setup(async () => { throw error; });
    store.startSession("acme/repo", "main");
    const events: string[] = [];
    const unsubscribeFirst = store.subscribe(() => {
      if (store.getSnapshot().nodesByPath[""].error) {
        events.push("first");
        throw new Error("synthetic row notification failure");
      }
    });
    store.subscribe(() => {
      if (store.getSnapshot().nodesByPath[""]?.error) events.push("last");
    });
    try {
      await expect(store.loadDirectory("")).rejects.toBe(error);
      expect(events).toEqual(["first", "last"]);
      expect(store.getSnapshot().nodesByPath[""]).toMatchObject({ loading: false, loaded: false, error: { code: "network" } });
    } finally {
      unsubscribeFirst();
    }
  });

  it("excludes subscribers removed during fan-out and defers newly added subscribers", () => {
    const { store } = setup();
    store.startSession("acme/repo", "main");
    const events: string[] = [];
    const error = new Error("synthetic fan-out failure");
    let unsubscribeRemoved: () => void = () => undefined;
    const unsubscribeFirst = store.subscribe(() => {
      events.push("first");
      unsubscribeRemoved();
      store.subscribe(() => { events.push("new"); });
      throw error;
    });
    unsubscribeRemoved = store.subscribe(() => { events.push("removed"); });
    store.subscribe(() => { events.push("last"); });
    try {
      expect(() => store.clearSensitiveData()).toThrow(error);
      expect(events).toEqual(["first", "last"]);
    } finally {
      unsubscribeFirst();
    }
    store.clearSensitiveData();
    expect(events).toEqual(["first", "last", "last", "new"]);
  });

  it("propagates a throwing loading subscriber without leaking a request or leaving loading stuck", async () => {
    const { store, provider } = setup();
    store.startSession("acme/repo", "main");
    const error = new Error("synthetic loading subscriber failure");
    const unsubscribe = store.subscribe(() => { throw error; });
    await expect(store.loadDirectory("")).rejects.toBe(error);
    expect(store.getSnapshot().nodesByPath[""].loading).toBe(false);
    expect(provider.listDirectory).not.toHaveBeenCalled();
    unsubscribe();
    await store.loadDirectory("");
    expect(store.getSnapshot().nodesByPath[""].loaded).toBe(true);
  });

  it("preserves auth rejection when a clearing subscriber throws and still clears/cancels", async () => {
    const response = deferred<DirectoryListing>();
    const { store } = setup(() => response.promise);
    store.startSession("acme/repo", "main");
    const load = store.loadDirectory("");
    const error = new RepositoryError("signed-out", { status: 401 });
    const failed = expect(load).rejects.toBe(error);
    const unsubscribe = store.subscribe(() => { if (store.getSnapshot().repo === null) throw new Error("synthetic clearing subscriber failure"); });
    response.reject(error);
    await failed;
    expectCleared(store);
    unsubscribe();
  });

  it("does not log metadata or read/write persistent browser storage", async () => {
    const logging = ["log", "info", "warn", "error", "debug", "trace"] as const;
    const logs = logging.map((method) => vi.spyOn(console, method));
    const read = vi.spyOn(Storage.prototype, "getItem");
    const write = vi.spyOn(Storage.prototype, "setItem");
    const { store } = setup();
    store.startSession("acme/repo", "main");
    await store.loadDirectory("");
    await store.toggleDirectory("src");
    store.selectPath("src/index.ts");
    store.clearSensitiveData();
    store.dispose();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("integrates with the real provider/bridge and ignores a late page-world success after teardown", async () => {
    const store = createTreeStore(createSessionProvider(createBridgeClient(window, "synthetic-tree-channel")));
    stores.push(store);
    let request: BridgeRequest | undefined;
    const onRequest = (event: Event) => { if (event instanceof CustomEvent) request = event.detail; };
    window.addEventListener(BRIDGE_REQUEST_EVENT, onRequest);
    try {
      store.startSession("acme/repo", "main");
      const load = store.loadDirectory("");
      const cancelled = expect(load).rejects.toMatchObject({ code: "cancelled" });
      await Promise.resolve();
      expect(request?.operation).toEqual({
        platform: "cnb", type: "list-directory", repository: "acme/repo", ref: "main", path: "",
      });
      store.dispose();
      await cancelled;
      window.dispatchEvent(new CustomEvent(BRIDGE_RESPONSE_EVENT, { detail: {
        channel: request?.channel, requestId: request?.requestId, ok: true, status: 200, format: "json", data: treeFixture,
      } }));
      expectCleared(store);
    } finally {
      window.removeEventListener(BRIDGE_REQUEST_EVENT, onRequest);
    }
  });

  it.each([401, 403])("clears normalized real-provider nodes on a bridge HTTP %i", async (status) => {
    const channel = "synthetic-tree-auth-channel";
    const store = createTreeStore(createSessionProvider(createBridgeClient(window, channel)));
    stores.push(store);
    const onRequest = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const request: BridgeRequest = event.detail;
      if (request.channel !== channel || request.operation.type !== "list-directory") return;
      window.dispatchEvent(new CustomEvent(BRIDGE_RESPONSE_EVENT, { detail: request.operation.path === "" ? {
        channel, requestId: request.requestId, ok: true, status: 200,
        format: "json", data: { ...treeFixture, path: "", name: "", entries: [
          { type: "tree", name: "src", path: "src", sha: "src-sha" },
        ] },
      } : {
        channel, requestId: request.requestId, ok: false, status, code: status === 401 ? "signed-out" : "forbidden",
      } }));
    };
    window.addEventListener(BRIDGE_REQUEST_EVENT, onRequest);
    try {
      store.startSession("acme/repo", "main");
      await store.loadDirectory("");
      expect(store.getSnapshot().visibleNodes.map((node) => node.path)).toEqual(["src"]);
      store.selectPath("src");
      await expect(store.toggleDirectory("src")).rejects.toMatchObject({ code: status === 401 ? "signed-out" : "forbidden", status });
      expectCleared(store);
    } finally {
      window.removeEventListener(BRIDGE_REQUEST_EVENT, onRequest);
    }
  });
});
