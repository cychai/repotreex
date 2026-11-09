import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRepoTreeController, type RepoTreeController } from "../src/content/controller";
import { mountTreePanel, type PanelOptions, type TreePanel } from "../src/content/panel";
import { createPreferenceStore } from "../src/content/preferences";
import type { DirectoryListing, RepositoryProvider } from "../src/content/provider";
import { createTreeStore } from "../src/content/tree-store";
import { RepositoryError } from "../src/shared/errors";
import { cnbAdapter } from "../src/platforms/cnb";

const controllers: RepoTreeController[] = [];
beforeEach(() => { Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: vi.fn(), configurable: true }); });
const url = (path = "acme/repo") => new URL(`https://cnb.cool/${path}`);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function listing(path: string, entries: [string, "file" | "directory"][]): DirectoryListing {
  return { path, sha: "synthetic-tree", entries: entries.map(([path, kind]) => ({
    path, kind, name: path.split("/").at(-1) ?? "", sha: "synthetic-entry",
  })) };
}
function setup(patch: Partial<RepositoryProvider> = {}) {
  const provider: RepositoryProvider = {
    getHead: vi.fn(async () => "main"),
    listBranches: vi.fn(async () => ["main", "dev", "release", "release/v1"].map((name) => ({ kind: "branch" as const, name, sha: "synthetic-ref" }))),
    listTags: vi.fn(async () => [{ kind: "tag" as const, name: "release/v1/patch", sha: "synthetic-tag" }]),
    listDirectory: vi.fn(async (_repo, _ref, path) => path === "" ? listing("", [["src", "directory"], ["a.ts", "file"], ["b.ts", "file"]])
      : path === "src" ? listing("src", [["src/nested", "directory"], ["src/a b.ts", "file"]])
      : listing("src/nested", [["src/nested/app.ts", "file"]])),
    dispose: vi.fn(), ...patch,
  };
  const store = createTreeStore(provider);
  const startSession = vi.spyOn(store, "startSession");
  let stored: Record<string, unknown> = {};
  const storage = {
    get: vi.fn(async () => structuredClone(stored)),
    set: vi.fn(async (items: Record<string, unknown>) => { stored = structuredClone(items); }),
  };
  const navigate = vi.fn();
  let panel!: TreePanel;
  let actions!: PanelOptions;
  let currentUrl = url();
  const controller = createRepoTreeController({
    window, adapter: cnbAdapter, provider, store, preferences: createPreferenceStore(storage), navigate,
    getUrl: () => currentUrl,
    mountPanel(options) { actions = options; panel = mountTreePanel(options); return panel; },
  });
  controllers.push(controller);
  const settle = async () => { await vi.waitFor(() => expect(panel.root.querySelector('[aria-busy="true"]')).toBeNull()); };
  const navigateTo = async (next: URL) => { currentUrl = next; await controller.handleNavigation(next); };
  return { provider, store, storage, navigate, controller, startSession, settle, navigateTo,
    get panel() { return panel; }, get actions() { return actions; } };
}
const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 40)); };
afterEach(() => { for (const controller of controllers.splice(0)) controller.destroy(); vi.restoreAllMocks(); });

describe("route controller integration", () => {
  it("retains file-only sessions, selects paths, and replaces ref sessions", async () => {
    const t = setup();
    await t.navigateTo(url("acme/repo/-/blob/main/a.ts"));
    const root = t.store.getSnapshot().nodesByPath[""];
    await t.navigateTo(url("acme/repo/-/blob/main/b.ts"));
    expect(t.startSession).toHaveBeenCalledTimes(1);
    expect(t.store.getSnapshot().nodesByPath[""]).toEqual(root);
    expect(t.provider.listDirectory).toHaveBeenCalledTimes(1);
    expect(t.store.getSnapshot().selectedPath).toBe("b.ts");
    await t.navigateTo(url("acme/repo/-/blob/dev/b.ts"));
    expect(t.startSession).toHaveBeenCalledTimes(2);
    expect(t.store.getSnapshot().ref).toBe("dev");
  });
  it.each(["release/v1/patch", "release%2Fv1%2Fpatch"])("reconciles longest branch/tag prefix %s in nested repositories", async (ref) => {
    const t = setup(); await t.navigateTo(url(`acme/platform/web/-/blob/${ref}/src/nested/app.ts`));
    expect(t.store.getSnapshot()).toMatchObject({ repo: "acme/platform/web", ref: "release/v1/patch", selectedPath: "src/nested/app.ts", expandedPaths: ["src", "src/nested"] });
    expect(t.provider.listDirectory).toHaveBeenNthCalledWith(1, "acme/platform/web", "release/v1/patch", "", expect.any(AbortSignal));
    expect(t.provider.listDirectory).toHaveBeenNthCalledWith(2, "acme/platform/web", "release/v1/patch", "src", expect.any(AbortSignal));
    expect(t.provider.listDirectory).toHaveBeenNthCalledWith(3, "acme/platform/web", "release/v1/patch", "src/nested", expect.any(AbortSignal));
    await flush(); expect(t.panel.root.querySelector('[aria-selected="true"]')?.getAttribute("data-path")).toBe("src/nested/app.ts");
  });
  it("resolves head and both ref kinds concurrently before starting a session", async () => {
    const head = deferred<string>(); const branches = deferred<[]>(); const tags = deferred<[]>();
    const t = setup({ getHead: vi.fn(() => head.promise), listBranches: vi.fn(() => branches.promise), listTags: vi.fn(() => tags.promise) });
    const navigation = t.navigateTo(url());
    await vi.waitFor(() => expect(t.provider.listTags).toHaveBeenCalledTimes(1));
    expect(t.provider.getHead).toHaveBeenCalledTimes(1); expect(t.provider.listBranches).toHaveBeenCalledTimes(1);
    expect(t.startSession).not.toHaveBeenCalled(); head.resolve("main"); branches.resolve([]); tags.resolve([]);
    await navigation; expect(t.store.getSnapshot().ref).toBe("main");
  });
  it("uses explicit HEAD fallback only when HEAD discovery is not found", async () => {
    const t = setup({ getHead: vi.fn(async () => { throw new RepositoryError("not-found", { status: 404 }); }) });
    await t.navigateTo(url()); await flush();
    expect(t.store.getSnapshot().ref).toBe("HEAD"); expect(t.panel.root.textContent).toContain("HEAD");
  });
  it.each(["acme/repo/-/issues", "profile/me", "acme/repo/-/blob/unknown%2Fref/a.ts", "acme/repo/-/blob/main/src%2Fa.ts"])("clears and unmounts unsupported %s", async (path) => {
    const t = setup(); await t.navigateTo(url());
    await t.navigateTo(url(path));
    expect(t.store.getSnapshot().repo).toBeNull(); expect(document.getElementById("repotreex-root")).toBeNull();
    await t.navigateTo(url()); expect(document.getElementById("repotreex-root")).not.toBeNull();
  });
  it("opens files only through canonical encoded CNB URLs", async () => {
    const t = setup(); await t.navigateTo(url("acme/platform/web/-/blob/release/v1/src/a%20b.ts"));
    t.actions.onOpenFile("src/a b.ts");
    expect(t.navigate).toHaveBeenCalledExactlyOnceWith("https://cnb.cool/acme/platform/web/-/blob/release%2Fv1/src/a%20b.ts");
    t.actions.onOpenFile("https://evil.example"); expect(t.navigate).toHaveBeenCalledTimes(1);
  });
  it("navigates ref selection canonically, preserving a file only on successful lookup", async () => {
    const t = setup(); await t.navigateTo(url("acme/repo/-/blob/main/a.ts"));
    t.actions.onSelectRef("release/v1");
    expect(t.navigate).toHaveBeenLastCalledWith("https://cnb.cool/acme/repo/-/blob/release%2Fv1/a.ts");
    await t.navigateTo(new URL(t.navigate.mock.calls[0][0]));
    expect(t.store.getSnapshot()).toMatchObject({ ref: "release/v1", selectedPath: "a.ts" });
  });
  it("falls back to the selected ref root with a metadata-free notice on missing path", async () => {
    const t = setup(); await t.navigateTo(url("acme/repo/-/blob/main/a.ts"));
    t.actions.onSelectRef("dev");
    vi.mocked(t.provider.listDirectory).mockResolvedValue(listing("", [["b.ts", "file"]]));
    await t.navigateTo(new URL(t.navigate.mock.calls[0][0]));
    expect(t.navigate).toHaveBeenLastCalledWith("https://cnb.cool/acme/repo/-/blob/dev#repotreex-path-not-found");
    expect(t.store.getSnapshot().selectedPath).toBeNull();
    await t.navigateTo(new URL(t.navigate.mock.calls.at(-1)?.[0])); await flush();
    expect(t.panel.root.textContent).toContain("not available on this ref");
  });
  it.each(["signed-out", "forbidden"] as const)("scrubs store and panel immediately after directory %s", async (code) => {
    const gate = deferred<DirectoryListing>(); const t = setup(); await t.navigateTo(url()); await flush();
    const oldRow = t.panel.root.querySelector('[data-path="a.ts"]');
    vi.mocked(t.provider.listDirectory).mockReturnValue(gate.promise); t.actions.onToggleDirectory("src");
    await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath.src.loading).toBe(true));
    gate.reject(new RepositoryError(code, { status: code === "signed-out" ? 401 : 403 }));
    await vi.waitFor(() => expect(t.store.getSnapshot().repo).toBeNull());
    expect(oldRow?.textContent).toBe(""); expect(t.panel.root.querySelectorAll('[data-path]')).toHaveLength(0);
    expect(t.panel.root.querySelector('[aria-label="Repository ref"]')?.textContent).toBe("");
    await flush(); expect(t.panel.root.textContent).toContain(code === "signed-out" ? "login expired" : "access denied");
  });
  it.each(["signed-out", "forbidden", "network", "server", "compatibility", "rate-limited"] as const)("maps discovery %s without starting a tree session", async (code) => {
    const t = setup({ listTags: vi.fn(async () => { throw new RepositoryError(code); }) });
    await t.navigateTo(url()); await flush();
    expect(t.store.getSnapshot().repo).toBeNull(); expect(t.panel.root.querySelector('[role="alert"]')?.textContent).not.toBe("");
  });
  it("aborts outgoing discovery and ignores late old success and authorization failures", async () => {
    const gate = deferred<string>(); const signals: AbortSignal[] = [];
    const t = setup({ getHead: vi.fn((_repo, signal) => { if (signal) signals.push(signal); return signals.length === 1 ? gate.promise : Promise.resolve("main"); }) });
    const old = t.navigateTo(url("private/old")); await vi.waitFor(() => expect(signals).toHaveLength(1));
    await t.navigateTo(url("public/new")); expect(signals[0].aborted).toBe(true);
    gate.reject(new RepositoryError("signed-out")); await old;
    expect(t.store.getSnapshot().repo).toBe("public/new");
  });
  it("clears and aborts the old session before replacement discovery settles", async () => {
    const t = setup(); await t.navigateTo(url()); await flush();
    const root = deferred<DirectoryListing>(); const signals: AbortSignal[] = [];
    vi.mocked(t.provider.listDirectory).mockImplementation((_repo, _ref, _path, signal) => { if (signal) signals.push(signal); return root.promise; });
    t.actions.onToggleDirectory("src"); await vi.waitFor(() => expect(signals).toHaveLength(1));
    const head = deferred<string>(); vi.mocked(t.provider.getHead).mockReturnValue(head.promise);
    const next = t.navigateTo(url("another/repo"));
    expect(t.store.getSnapshot().repo).toBeNull(); expect(signals[0].aborted).toBe(true);
    head.resolve("dev"); root.resolve(listing("", [])); await next;
  });
  it("retains loaded nodes on network failure and retries the failed directory", async () => {
    const t = setup(); await t.navigateTo(url());
    vi.mocked(t.provider.listDirectory).mockRejectedValueOnce(new RepositoryError("network"));
    t.actions.onToggleDirectory("src"); await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath.src.error?.code).toBe("network"));
    expect(t.store.getSnapshot().nodesByPath["a.ts"]).toBeDefined();
    t.actions.onRetryDirectory?.("src"); await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath.src.loaded).toBe(true));
    expect(t.store.getSnapshot().nodesByPath.src.expanded).toBe(true);
  });
  it("refreshes only the current repo/ref, retaining no prior cached data", async () => {
    const t = setup(); await t.navigateTo(url("acme/repo/-/blob/dev/a.ts"));
    t.actions.onRefresh(); await vi.waitFor(() => expect(t.startSession).toHaveBeenCalledTimes(2)); await t.settle();
    expect(t.startSession).toHaveBeenLastCalledWith("acme/repo", "dev"); expect(t.provider.getHead).toHaveBeenCalledTimes(1);
  });
  it("wires loaded search and full traversal, and disables traversal during rate limiting until retry", async () => {
    const t = setup(); await t.navigateTo(url()); t.actions.onSearch("a.ts"); await flush();
    expect(t.panel.root.querySelectorAll('[role="treeitem"]')).toHaveLength(1);
    vi.mocked(t.provider.listDirectory).mockRejectedValueOnce(new RepositoryError("rate-limited"));
    t.actions.onLoadFullTree(); await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath.src.error?.code).toBe("rate-limited")); await flush();
    expect(t.panel.root.querySelector<HTMLButtonElement>('[aria-label="Load full tree for search"]')?.disabled).toBe(true);
    t.panel.root.querySelector<HTMLButtonElement>('[aria-label="Retry full-tree search"]')?.click();
    await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath["src/nested"].loaded).toBe(true));
  });
  it("cancels full traversal on file navigation and ignores late progress", async () => {
    const t = setup(); await t.navigateTo(url()); const gate = deferred<DirectoryListing>();
    vi.mocked(t.provider.listDirectory).mockReturnValueOnce(gate.promise); t.actions.onLoadFullTree();
    await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath.src.loading).toBe(true));
    await t.navigateTo(url("acme/repo/-/blob/main/b.ts")); gate.resolve(listing("src", [])); await flush();
    expect(t.panel.root.textContent).not.toContain("Loading full tree:"); expect(t.store.getSnapshot().selectedPath).toBe("b.ts");
  });
  it("loads and serializes only panel open/width preferences, surfacing storage failures", async () => {
    const t = setup(); t.storage.get.mockRejectedValueOnce(new Error("secret metadata"));
    await t.navigateTo(url()); await flush(); expect(t.panel.root.textContent).toContain("preferences"); expect(t.panel.root.textContent).not.toContain("secret metadata");
    t.actions.onPreferenceChange({ panelOpen: false }); t.actions.onPreferenceChange({ panelWidth: 400 });
    await vi.waitFor(() => expect(t.storage.set).toHaveBeenCalledTimes(2));
    expect(t.storage.set.mock.calls.at(-1)).toEqual([{ "repotreex.preferences": { panelOpen: false, panelWidth: 400 } }]);
    t.storage.set.mockRejectedValueOnce(new Error("private path")); t.actions.onPreferenceChange({ panelOpen: true }); await flush();
    expect(t.panel.root.textContent).toContain("not saved"); expect(t.panel.root.textContent).not.toContain("private path");
  });
  it("destroy is idempotent and aborts data work, unsubscribes, disposes and unmounts", async () => {
    const t = setup(); await t.navigateTo(url()); const gate = deferred<DirectoryListing>();
    vi.mocked(t.provider.listDirectory).mockReturnValue(gate.promise); t.actions.onLoadFullTree();
    await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath.src.loading).toBe(true));
    t.controller.destroy(); t.controller.destroy(); gate.resolve(listing("src", [])); await flush();
    expect(t.store.getSnapshot().repo).toBeNull(); expect(t.provider.dispose).toHaveBeenCalledTimes(1);
    expect(document.getElementById("repotreex-root")).toBeNull();
    await t.navigateTo(url()); expect(document.getElementById("repotreex-root")).toBeNull();
  });
  it("aborts sibling discovery promptly on failure even while preferences are pending", async () => {
    const tags = deferred<[]>(); const prefs = deferred<Record<string, unknown>>(); const signals: AbortSignal[] = [];
    const t = setup({ listBranches: vi.fn((_repo, signal) => {
      if (signal) signals.push(signal);
      return new Promise<[]>(() => {});
    }), listTags: vi.fn(() => tags.promise) });
    t.storage.get.mockReturnValue(prefs.promise);
    const pending = t.navigateTo(url()); tags.reject(new RepositoryError("signed-out"));
    await vi.waitFor(() => expect(signals[0].aborted).toBe(true));
    prefs.resolve({}); await pending;
    expect(t.store.getSnapshot().repo).toBeNull();
  });
  it("keeps full traversal rate-limited across file-only navigation until explicit retry", async () => {
    const t = setup(); await t.navigateTo(url());
    vi.mocked(t.provider.listDirectory).mockRejectedValueOnce(new RepositoryError("rate-limited"));
    t.actions.onLoadFullTree(); await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath.src.error?.code).toBe("rate-limited"));
    await t.navigateTo(url("acme/repo/-/blob/main/a.ts")); await flush();
    expect(t.panel.root.querySelector<HTMLButtonElement>('[aria-label="Load full tree for search"]')?.disabled).toBe(true);
    t.actions.onRetryDirectory?.("src"); await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath.src.loaded).toBe(true)); await flush();
    expect(t.panel.root.querySelector<HTMLButtonElement>('[aria-label="Load full tree for search"]')?.disabled).toBe(false);
  });
  it("does not clear a current-path network error after unrelated directory success", async () => {
    const t = setup(); await t.navigateTo(url());
    vi.mocked(t.provider.listDirectory).mockRejectedValueOnce(new RepositoryError("network"));
    await t.navigateTo(url("acme/repo/-/blob/main/src/a%20b.ts")); await flush();
    expect(t.panel.root.querySelector('[aria-label="Retry repository tree"]')).not.toBeNull();
    await t.store.loadDirectory("src");
    t.actions.onToggleDirectory("src/nested"); await flush();
    expect(t.panel.root.querySelector('[aria-label="Retry repository tree"]')).not.toBeNull();
  });
  it.each(["signed-out", "forbidden"] as const)("shows full traversal %s even when sibling cancellation follows store clearing", async (code) => {
    const t = setup(); await t.navigateTo(url());
    vi.mocked(t.provider.listDirectory).mockRejectedValueOnce(new RepositoryError(code));
    t.actions.onLoadFullTree(); await vi.waitFor(() => expect(t.store.getSnapshot().repo).toBeNull()); await flush();
    expect(t.panel.root.textContent).toContain(code === "signed-out" ? "login expired" : "access denied");
  });
  it("ignores late root success after a newer ref session", async () => {
    const gate = deferred<DirectoryListing>(); const t = setup({ listDirectory: vi.fn((_repo, ref) => ref === "main" ? gate.promise : Promise.resolve(listing("", [["b.ts", "file"]]))) });
    const old = t.navigateTo(url()); await vi.waitFor(() => expect(t.provider.listDirectory).toHaveBeenCalledTimes(1));
    await t.navigateTo(url("acme/repo/-/blob/dev/b.ts")); gate.resolve(listing("", [["secret.ts", "file"]])); await old;
    expect(t.store.getSnapshot().ref).toBe("dev"); expect(t.store.getSnapshot().nodesByPath["secret.ts"]).toBeUndefined();
  });
  it("settles abandoned navigation promptly if a provider ignores abort", async () => {
    const t = setup({ getHead: vi.fn(() => new Promise<string>(() => {})) });
    let settled = false; void t.navigateTo(url()).then(() => { settled = true; });
    await vi.waitFor(() => expect(document.getElementById("repotreex-root")).not.toBeNull());
    await t.navigateTo(url("profile/me")); await vi.waitFor(() => expect(settled).toBe(true));
  });
  it("preserves live tab preferences across unsupported-route unmount even after failed persistence", async () => {
    const t = setup(); await t.navigateTo(url()); t.storage.set.mockRejectedValue(new Error("storage unavailable"));
    t.actions.onPreferenceChange({ panelOpen: false, panelWidth: 470 }); await flush();
    await t.navigateTo(url("profile/me")); await t.navigateTo(url());
    expect(t.panel.host.dataset.open).toBe("false"); expect(t.panel.host.style.getPropertyValue("--repotreex-panel-width")).toBe("470px");
  });
  it.each(["signed-out", "forbidden"] as const)("shows current-session %s from a directory started before file-only navigation", async (code) => {
    const t = setup(); await t.navigateTo(url()); const gate = deferred<DirectoryListing>();
    vi.mocked(t.provider.listDirectory).mockReturnValueOnce(gate.promise); t.actions.onToggleDirectory("src");
    await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath.src.loading).toBe(true));
    await t.navigateTo(url("acme/repo/-/blob/main/a.ts")); gate.reject(new RepositoryError(code));
    await vi.waitFor(() => expect(t.store.getSnapshot().repo).toBeNull()); await flush();
    expect(t.panel.root.textContent).toContain(code === "signed-out" ? "login expired" : "access denied");
  });
  it("treats a blob directory path as a directory selection, not a file to preserve across refs", async () => {
    const t = setup(); await t.navigateTo(url("acme/repo/-/blob/main/src"));
    expect(t.store.getSnapshot().nodesByPath.src.expanded).toBe(true);
    t.actions.onSelectRef("dev"); expect(t.navigate).toHaveBeenLastCalledWith("https://cnb.cool/acme/repo/-/blob/dev");
  });
  it("surfaces discovery failure with a working retry even when no tree session exists", async () => {
    const t = setup(); vi.mocked(t.provider.getHead).mockRejectedValueOnce(new RepositoryError("network"));
    await t.navigateTo(url()); await flush();
    t.panel.root.querySelector<HTMLButtonElement>('[aria-label="Retry repository tree"]')?.click();
    await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath["a.ts"]).toBeDefined());
  });
  it("preserves auth status from an abandoned ancestor load in the retained session", async () => {
    const t = setup(); await t.navigateTo(url()); const gate = deferred<DirectoryListing>();
    vi.mocked(t.provider.listDirectory).mockReturnValueOnce(gate.promise);
    const old = t.navigateTo(url("acme/repo/-/blob/main/src/nested/app.ts"));
    await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath.src.loading).toBe(true));
    await t.navigateTo(url("acme/repo/-/blob/main/a.ts")); gate.reject(new RepositoryError("signed-out")); await old;
    await vi.waitFor(() => expect(t.store.getSnapshot().repo).toBeNull());
    await vi.waitFor(() => expect(t.panel.root.querySelector('[role="alert"]')?.textContent).toContain("login expired"));
  });
  it("ref choice preserves the current URL file even before ancestors have loaded", async () => {
    const t = setup(); await t.navigateTo(url()); const gate = deferred<DirectoryListing>();
    vi.mocked(t.provider.listDirectory).mockReturnValueOnce(gate.promise);
    const pending = t.navigateTo(url("acme/repo/-/blob/main/src/nested/app.ts"));
    await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath.src.loading).toBe(true));
    t.actions.onSelectRef("dev"); expect(t.navigate).toHaveBeenLastCalledWith("https://cnb.cool/acme/repo/-/blob/dev/src/nested/app.ts");
    t.controller.destroy(); gate.resolve(listing("src", [])); await pending;
  });
  it("aborts sibling work when refresh replaces the pending path load", async () => {
    const t = setup(); await t.navigateTo(url("acme/repo/-/blob/main/a.ts"));
    const gate = deferred<DirectoryListing>(); let signal: AbortSignal | undefined;
    vi.mocked(t.provider.listDirectory).mockImplementationOnce((_repo, _ref, _path, incoming) => { signal = incoming; return gate.promise; });
    t.actions.onToggleDirectory("src"); await vi.waitFor(() => expect(signal).toBeDefined());
    t.actions.onRefresh(); await vi.waitFor(() => expect(t.store.getSnapshot().selectedPath).toBe("a.ts"));
    expect(signal?.aborted).toBe(true); gate.resolve(listing("src", [["src/secret.ts", "file"]])); await flush();
    expect(t.store.getSnapshot().nodesByPath["src/secret.ts"]).toBeUndefined();
  });
  it("finishes teardown even if panel cleanup throws, without retaining the store", async () => {
    const t = setup(); await t.navigateTo(url());
    vi.spyOn(t.panel, "destroy").mockImplementationOnce(() => { throw new Error("synthetic cleanup failure"); });
    expect(() => t.controller.destroy()).toThrow("synthetic cleanup failure");
    expect(t.store.getSnapshot().repo).toBeNull(); expect(t.provider.dispose).toHaveBeenCalledTimes(1);
    t.panel.destroy();
  });
  it("settles abandoned ancestor reveal promptly on file-only navigation without replacing the session", async () => {
    const t = setup(); await t.navigateTo(url()); const gate = deferred<DirectoryListing>();
    vi.mocked(t.provider.listDirectory).mockReturnValueOnce(gate.promise);
    let settled = false; void t.navigateTo(url("acme/repo/-/blob/main/src/nested/app.ts")).then(() => { settled = true; });
    await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath.src.loading).toBe(true));
    await t.navigateTo(url("acme/repo/-/blob/main/a.ts")); await vi.waitFor(() => expect(settled).toBe(true));
    expect(t.startSession).toHaveBeenCalledTimes(1); gate.resolve(listing("src", []));
  });
  it("preserves auth errors arriving after abandoned reveal settles", async () => {
    const t = setup(); await t.navigateTo(url()); const gate = deferred<DirectoryListing>();
    vi.mocked(t.provider.listDirectory).mockReturnValueOnce(gate.promise);
    const old = t.navigateTo(url("acme/repo/-/blob/main/src/nested/app.ts"));
    await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath.src.loading).toBe(true));
    await t.navigateTo(url("acme/repo/-/blob/main/a.ts"));
    gate.reject(new RepositoryError("forbidden")); await old;
    await vi.waitFor(() => expect(t.panel.root.querySelector('[role="alert"]')?.textContent).toContain("access denied"));
  });
  it("drops queued preference writes after destruction and ignores late persistence notices", async () => {
    const t = setup(); await t.navigateTo(url()); const gate = deferred<undefined>();
    t.storage.set.mockReturnValueOnce(gate.promise);
    t.actions.onPreferenceChange({ panelWidth: 410 }); t.actions.onPreferenceChange({ panelOpen: false });
    await vi.waitFor(() => expect(t.storage.set).toHaveBeenCalledTimes(1)); t.controller.destroy();
    gate.reject(new Error("metadata must stay private")); await flush();
    expect(t.storage.set).toHaveBeenCalledTimes(1); expect(document.getElementById("repotreex-root")).toBeNull();
  });
  it("leaves repository/ref discovery data unpublished until the entire discovery succeeds", async () => {
    const gate = deferred<[]>(); const t = setup({ listTags: vi.fn(() => gate.promise) });
    const pending = t.navigateTo(url()); await vi.waitFor(() => expect(document.getElementById("repotreex-root")).not.toBeNull());
    expect(t.store.getSnapshot().repo).toBeNull(); expect(t.panel.root.querySelector('select')?.options).toHaveLength(0);
    gate.resolve([]); await pending;
  });
  it.each(["reveal", "traversal", "cancel"] as const)("retains same-session late 429 after detached %s until explicit recovery", async (operation) => {
    const t = setup(); await t.navigateTo(url()); const gate = deferred<DirectoryListing>();
    vi.mocked(t.provider.listDirectory).mockReturnValueOnce(gate.promise);
    const pending = operation === "reveal" ? t.navigateTo(url("acme/repo/-/blob/main/src/nested/app.ts")) : Promise.resolve();
    if (operation !== "reveal") t.actions.onLoadFullTree();
    await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath.src.loading).toBe(true));
    if (operation === "cancel") t.actions.onCancelFullTree?.();
    else await t.navigateTo(url("acme/repo/-/blob/main/a.ts"));
    gate.reject(new RepositoryError("rate-limited", { status: 429 })); await pending; await flush();
    expect(t.panel.root.querySelector<HTMLButtonElement>('[aria-label="Load full tree for search"]')?.disabled).toBe(true);
    const count = vi.mocked(t.provider.listDirectory).mock.calls.length;
    t.actions.onLoadFullTree(); await flush(); expect(t.provider.listDirectory).toHaveBeenCalledTimes(count);
    expect(t.panel.root.textContent).not.toContain("src/nested/app.ts");
    t.actions.onRetryDirectory?.("src");
    await vi.waitFor(() => expect(t.panel.root.querySelector<HTMLButtonElement>('[aria-label="Load full tree for search"]')?.disabled).toBe(false));
  });
  it("ignores late 429 from a replaced ref session", async () => {
    const t = setup(); await t.navigateTo(url()); const gate = deferred<DirectoryListing>();
    vi.mocked(t.provider.listDirectory).mockReturnValueOnce(gate.promise); t.actions.onLoadFullTree();
    await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath.src.loading).toBe(true));
    await t.navigateTo(url("acme/repo/-/blob/dev/a.ts")); gate.reject(new RepositoryError("rate-limited")); await flush();
    expect(t.panel.root.querySelector<HTMLButtonElement>('[aria-label="Load full tree for search"]')?.disabled).toBe(false);
  });
  it.each(["", "src", "src/nested"])("matching directory retry at %s resumes sequential current-file reveal", async (failedPath) => {
    const t = setup(); const original = vi.mocked(t.provider.listDirectory).getMockImplementation();
    if (!original) throw new Error("Missing synthetic directory provider");
    let failed = false;
    vi.mocked(t.provider.listDirectory).mockImplementation(async (...args) => {
      if (args[2] === failedPath && !failed) { failed = true; throw new RepositoryError("network"); }
      return original(...args);
    });
    await t.navigateTo(url("acme/repo/-/blob/main/src/nested/app.ts")); await flush();
    expect(t.store.getSnapshot().selectedPath).toBeNull();
    t.actions.onRetryDirectory?.(failedPath);
    await vi.waitFor(() => expect(t.store.getSnapshot().selectedPath).toBe("src/nested/app.ts")); await flush();
    expect(t.panel.root.querySelector('[aria-label="Retry repository tree"]')).toBeNull();
    expect(t.panel.root.querySelector('[aria-selected="true"]')?.getAttribute("data-path")).toBe("src/nested/app.ts");
  });
  it("matching retry clears its directory failure without clearing another directory failure", async () => {
    const t = setup({ listDirectory: vi.fn(async (_repo, _ref, path) => path === ""
      ? listing("", [["src", "directory"], ["docs", "directory"]]) : listing(path, []) ) });
    await t.navigateTo(url());
    vi.mocked(t.provider.listDirectory).mockRejectedValueOnce(new RepositoryError("network"));
    t.actions.onToggleDirectory("src"); await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath.src.error?.code).toBe("network"));
    vi.mocked(t.provider.listDirectory).mockRejectedValueOnce(new RepositoryError("server"));
    t.actions.onToggleDirectory("docs"); await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath.docs.error?.code).toBe("server"));
    t.actions.onRetryDirectory?.("src"); await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath.src.loaded).toBe(true));
    expect(t.store.getSnapshot().nodesByPath.docs.error?.code).toBe("server");
    t.actions.onRetryDirectory?.("docs"); await flush();
    expect(t.panel.root.querySelector('[aria-label="Retry repository tree"]')).toBeNull();
    expect(t.panel.root.querySelector('[aria-label="Retry directory"]')).toBeNull();
  });
  it("full search success does not clear a reveal-owned error or resume reveal implicitly", async () => {
    const t = setup(); await t.navigateTo(url());
    vi.mocked(t.provider.listDirectory).mockRejectedValueOnce(new RepositoryError("network"));
    await t.navigateTo(url("acme/repo/-/blob/main/src/nested/app.ts"));
    t.actions.onLoadFullTree(); await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath["src/nested"].loaded).toBe(true)); await flush();
    expect(t.store.getSnapshot().selectedPath).toBeNull();
    expect(t.panel.root.querySelector('[aria-label="Retry repository tree"]')).not.toBeNull();
    t.actions.onRetryDirectory?.("src"); await vi.waitFor(() => expect(t.store.getSnapshot().selectedPath).toBe("src/nested/app.ts"));
  });
  it("full search success leaves a directory-owned failure until matching explicit retry", async () => {
    const t = setup(); await t.navigateTo(url());
    vi.mocked(t.provider.listDirectory).mockRejectedValueOnce(new RepositoryError("server"));
    t.actions.onToggleDirectory("src"); await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath.src.error?.code).toBe("server"));
    t.actions.onLoadFullTree(); await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath["src/nested"].loaded).toBe(true)); await flush();
    expect(t.panel.root.querySelector('[aria-label="Retry repository tree"]')).not.toBeNull();
    t.actions.onRetryDirectory?.("src"); await flush();
    expect(t.panel.root.querySelector('[aria-label="Retry repository tree"]')).toBeNull();
  });
  it("a directory retry overtaken by navigation cannot reveal the outgoing file", async () => {
    const t = setup(); await t.navigateTo(url());
    vi.mocked(t.provider.listDirectory).mockRejectedValueOnce(new RepositoryError("network"));
    await t.navigateTo(url("acme/repo/-/blob/main/src/nested/app.ts"));
    const gate = deferred<DirectoryListing>(); vi.mocked(t.provider.listDirectory).mockReturnValueOnce(gate.promise);
    t.actions.onRetryDirectory?.("src"); await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath.src.loading).toBe(true));
    await t.navigateTo(url("acme/repo/-/blob/main/b.ts")); gate.resolve(listing("src", [["src/nested", "directory"]])); await flush();
    expect(t.store.getSnapshot().selectedPath).toBe("b.ts");
    expect(t.store.getSnapshot().nodesByPath["src/nested"].loaded).toBe(false);
  });
  it("queued preference recovery persists the cumulative desired open and width after a failed patch", async () => {
    const t = setup(); await t.navigateTo(url()); const failed = deferred<undefined>(); const recovered = deferred<undefined>();
    const persist = t.storage.set.getMockImplementation();
    if (!persist) throw new Error("Missing synthetic storage writer");
    t.storage.set.mockReturnValueOnce(failed.promise);
    t.actions.onPreferenceChange({ panelOpen: false });
    await vi.waitFor(() => expect(t.storage.set).toHaveBeenCalledTimes(1));
    t.actions.onPreferenceChange({ panelWidth: 440 });
    t.storage.set.mockImplementationOnce(async (items) => { await recovered.promise; await persist(items); });
    failed.reject(new Error("private preference failure"));
    await vi.waitFor(() => expect(t.storage.set).toHaveBeenCalledTimes(2)); await flush();
    expect(t.panel.root.textContent).toContain("not saved");
    expect(t.storage.set.mock.calls[1]).toEqual([{ "repotreex.preferences": { panelOpen: false, panelWidth: 440 } }]);
    recovered.resolve(undefined); await vi.waitFor(() => expect(t.panel.root.textContent).not.toContain("not saved"));
    expect(await t.storage.get()).toEqual({ "repotreex.preferences": { panelOpen: false, panelWidth: 440 } });
  });
  it("preference failure notice survives success of an older intent until the newest intent persists", async () => {
    const t = setup(); await t.navigateTo(url());
    const persist = t.storage.set.getMockImplementation();
    if (!persist) throw new Error("Missing synthetic storage writer");
    t.storage.set.mockRejectedValueOnce(new Error("private")); t.actions.onPreferenceChange({ panelOpen: false });
    await vi.waitFor(() => expect(t.panel.root.textContent).toContain("not saved"));
    const older = deferred<undefined>(); const newest = deferred<undefined>();
    t.storage.set.mockImplementationOnce(async (items) => { await older.promise; await persist(items); })
      .mockImplementationOnce(async (items) => { await newest.promise; await persist(items); });
    t.actions.onPreferenceChange({ panelWidth: 400 }); await vi.waitFor(() => expect(t.storage.set).toHaveBeenCalledTimes(2));
    t.actions.onPreferenceChange({ panelOpen: true }); older.resolve(undefined);
    await vi.waitFor(() => expect(t.storage.set).toHaveBeenCalledTimes(3)); await flush();
    expect(t.panel.root.textContent).toContain("not saved");
    expect(await t.storage.get()).toEqual({ "repotreex.preferences": { panelOpen: false, panelWidth: 400 } });
    expect(t.storage.set.mock.calls[2]).toEqual([{ "repotreex.preferences": { panelOpen: true, panelWidth: 400 } }]);
    newest.resolve(undefined); await vi.waitFor(() => expect(t.panel.root.textContent).not.toContain("not saved"));
    expect(await t.storage.get()).toEqual({ "repotreex.preferences": { panelOpen: true, panelWidth: 400 } });
  });
  it("cumulative preference recovery after a failed read still preserves earlier unsaved settings", async () => {
    const t = setup(); await t.navigateTo(url());
    t.storage.get.mockRejectedValueOnce(new Error("private storage read"));
    t.actions.onPreferenceChange({ panelOpen: false });
    await vi.waitFor(() => expect(t.panel.root.textContent).toContain("not saved"));
    t.actions.onPreferenceChange({ panelWidth: 480 });
    await vi.waitFor(() => expect(t.panel.root.textContent).not.toContain("not saved"));
    expect(await t.storage.get()).toEqual({ "repotreex.preferences": { panelOpen: false, panelWidth: 480 } });
  });
  it("preserves a user collapse after full search loads a reveal dependency without owning its recovery", async () => {
    const t = setup(); await t.navigateTo(url());
    vi.mocked(t.provider.listDirectory).mockRejectedValueOnce(new RepositoryError("network"));
    await t.navigateTo(url("acme/repo/-/blob/main/src/nested/app.ts")); await flush();
    t.panel.root.querySelector<HTMLButtonElement>('[aria-label="Load full tree for search"]')?.click();
    await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath["src/nested"].loaded).toBe(true)); await flush();
    expect(t.store.getSnapshot().nodesByPath.src.expanded).toBe(true);
    expect(t.panel.root.querySelector('[aria-label="Retry repository tree"]')).not.toBeNull();
    const requests = vi.mocked(t.provider.listDirectory).mock.calls.length;
    t.panel.root.querySelector<HTMLElement>('[role="treeitem"][data-path="src"]')?.click(); await flush();
    expect(t.store.getSnapshot().nodesByPath.src.expanded).toBe(false);
    expect(t.store.getSnapshot().selectedPath).toBeNull();
    expect(t.panel.root.querySelector('[aria-label="Retry repository tree"]')).not.toBeNull();
    expect(t.panel.root.querySelector('[aria-selected="true"]')).toBeNull();
    expect(t.provider.listDirectory).toHaveBeenCalledTimes(requests);
    t.actions.onRetryDirectory?.("src");
    await vi.waitFor(() => expect(t.store.getSnapshot().selectedPath).toBe("src/nested/app.ts"));
    expect(t.store.getSnapshot().nodesByPath.src.expanded).toBe(true);
  });
  it("collapse-only success cannot clear a directory-owned failure after full search loads it", async () => {
    const t = setup(); await t.navigateTo(url()); await flush();
    vi.mocked(t.provider.listDirectory).mockRejectedValueOnce(new RepositoryError("server"));
    t.panel.root.querySelector<HTMLElement>('[role="treeitem"][data-path="src"]')?.click();
    await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath.src.error?.code).toBe("server")); await flush();
    t.panel.root.querySelector<HTMLButtonElement>('[aria-label="Load full tree for search"]')?.click();
    await vi.waitFor(() => expect(t.store.getSnapshot().nodesByPath["src/nested"].loaded).toBe(true)); await flush();
    expect(t.panel.root.querySelector('[aria-label="Retry repository tree"]')).not.toBeNull();
    t.panel.root.querySelector<HTMLElement>('[role="treeitem"][data-path="src"]')?.click(); await flush();
    expect(t.store.getSnapshot().nodesByPath.src.expanded).toBe(false);
    expect(t.panel.root.querySelector('[aria-label="Retry repository tree"]')).not.toBeNull();
    t.actions.onRetryDirectory?.("src"); await flush();
    expect(t.panel.root.querySelector('[aria-label="Retry repository tree"]')).toBeNull();
  });
  it("width-only panel changes preserve another tab's latest untouched open setting", async () => {
    const t = setup(); await t.navigateTo(url()); await flush();
    await createPreferenceStore(t.storage).save({ panelOpen: false });
    t.panel.root.querySelector<HTMLElement>('.resizer')?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await vi.waitFor(() => expect(t.storage.set).toHaveBeenCalledTimes(2));
    expect(await t.storage.get()).toEqual({ "repotreex.preferences": { panelOpen: false, panelWidth: 316 } });
  });
  it("open-only panel changes preserve another tab's latest untouched width setting", async () => {
    const t = setup(); await t.navigateTo(url()); await flush();
    await createPreferenceStore(t.storage).save({ panelWidth: 460 });
    t.panel.root.querySelector<HTMLButtonElement>('[aria-label="Collapse repository tree"]')?.click();
    await vi.waitFor(() => expect(t.storage.set).toHaveBeenCalledTimes(2));
    expect(await t.storage.get()).toEqual({ "repotreex.preferences": { panelOpen: false, panelWidth: 460 } });
  });
  it("width-only save preserves this tab's untouched open setting across unsupported-route remount", async () => {
    const t = setup(); await t.navigateTo(url()); await flush();
    await createPreferenceStore(t.storage).save({ panelOpen: false });
    t.panel.root.querySelector<HTMLElement>('.resizer')?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await vi.waitFor(() => expect(t.storage.set).toHaveBeenCalledTimes(2)); await flush();
    expect(await t.storage.get()).toEqual({ "repotreex.preferences": { panelOpen: false, panelWidth: 316 } });
    expect(t.panel.host.dataset.open).toBe("true");
    await t.navigateTo(url("profile/me"));
    expect(document.getElementById("repotreex-root")).toBeNull();
    await t.navigateTo(url()); await flush();
    expect(t.panel.host.dataset.open).toBe("true");
    expect(t.panel.host.style.getPropertyValue("--repotreex-panel-width")).toBe("316px");
    expect(await t.storage.get()).toEqual({ "repotreex.preferences": { panelOpen: false, panelWidth: 316 } });
  });
  it("open-only save preserves this tab's untouched width across unsupported-route remount", async () => {
    const t = setup(); await t.navigateTo(url()); await flush();
    await createPreferenceStore(t.storage).save({ panelWidth: 460 });
    t.panel.root.querySelector<HTMLButtonElement>('[aria-label="Collapse repository tree"]')?.click();
    await vi.waitFor(() => expect(t.storage.set).toHaveBeenCalledTimes(2)); await flush();
    expect(await t.storage.get()).toEqual({ "repotreex.preferences": { panelOpen: false, panelWidth: 460 } });
    expect(t.panel.host.style.getPropertyValue("--repotreex-panel-width")).toBe("300px");
    await t.navigateTo(url("profile/me"));
    expect(document.getElementById("repotreex-root")).toBeNull();
    await t.navigateTo(url()); await flush();
    expect(t.panel.host.dataset.open).toBe("false");
    expect(t.panel.host.style.getPropertyValue("--repotreex-panel-width")).toBe("300px");
    expect(await t.storage.get()).toEqual({ "repotreex.preferences": { panelOpen: false, panelWidth: 460 } });
  });
  it("successfully persisted local fields stop being dirty before later cross-tab saves", async () => {
    const t = setup(); await t.navigateTo(url()); await flush();
    t.panel.root.querySelector<HTMLButtonElement>('[aria-label="Collapse repository tree"]')?.click();
    await vi.waitFor(() => expect(t.storage.set).toHaveBeenCalledTimes(1));
    expect(await t.storage.get()).toEqual({ "repotreex.preferences": { panelOpen: false, panelWidth: 300 } });
    await createPreferenceStore(t.storage).save({ panelOpen: true });
    t.panel.root.querySelector<HTMLElement>('.resizer')?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await vi.waitFor(() => expect(t.storage.set).toHaveBeenCalledTimes(3));
    expect(await t.storage.get()).toEqual({ "repotreex.preferences": { panelOpen: true, panelWidth: 316 } });
  });
  it("failed local width recovery still merges an untouched external open value from current storage", async () => {
    const t = setup(); await t.navigateTo(url()); await flush();
    t.storage.set.mockRejectedValueOnce(new Error("synthetic storage failure"));
    t.panel.root.querySelector<HTMLElement>('.resizer')?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await vi.waitFor(() => expect(t.panel.root.textContent).toContain("not saved"));
    await createPreferenceStore(t.storage).save({ panelOpen: false });
    t.panel.root.querySelector<HTMLElement>('.resizer')?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await vi.waitFor(() => expect(t.panel.root.textContent).not.toContain("not saved"));
    expect(await t.storage.get()).toEqual({ "repotreex.preferences": { panelOpen: false, panelWidth: 332 } });
  });
  it("queued width changes do not replay an earlier open intent once it has persisted", async () => {
    const t = setup(); await t.navigateTo(url()); await flush();
    const gate = deferred<undefined>(); const persist = t.storage.set.getMockImplementation();
    if (!persist) throw new Error("Missing synthetic storage writer");
    t.storage.set.mockImplementationOnce(async (items) => {
      await gate.promise; await persist(items);
      // The other tab changes open after this write but before the queued width save reads storage.
      await createPreferenceStore(t.storage).save({ panelOpen: true });
    });
    t.panel.root.querySelector<HTMLButtonElement>('[aria-label="Collapse repository tree"]')?.click();
    await vi.waitFor(() => expect(t.storage.set).toHaveBeenCalledTimes(1));
    t.panel.root.querySelector<HTMLElement>('.resizer')?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    gate.resolve(undefined);
    await vi.waitFor(() => expect(t.storage.set).toHaveBeenCalledTimes(3));
    expect(await t.storage.get()).toEqual({ "repotreex.preferences": { panelOpen: true, panelWidth: 316 } });
  });
  it("same-valued newer user intent remains dirty until its own pending save succeeds", async () => {
    const t = setup(); await t.navigateTo(url()); await flush();
    const gate = deferred<undefined>(); const failed = deferred<undefined>(); const recovered = deferred<undefined>();
    const persist = t.storage.set.getMockImplementation();
    if (!persist) throw new Error("Missing synthetic storage writer");
    t.storage.set.mockImplementationOnce(async (items) => {
      await gate.promise; await persist(items);
      await createPreferenceStore(t.storage).save({ panelOpen: true });
    });
    t.panel.root.querySelector<HTMLButtonElement>('[aria-label="Collapse repository tree"]')?.click();
    await vi.waitFor(() => expect(t.storage.set).toHaveBeenCalledTimes(1));
    t.panel.root.querySelector<HTMLButtonElement>('[aria-label="Open repository tree"]')?.click();
    t.panel.root.querySelector<HTMLButtonElement>('[aria-label="Collapse repository tree"]')?.click();
    // The external write is first, followed by the queued true then false local intentions.
    t.storage.set.mockImplementationOnce(persist).mockReturnValueOnce(failed.promise)
      .mockImplementationOnce(async (items) => { await recovered.promise; await persist(items); });
    gate.resolve(undefined); await vi.waitFor(() => expect(t.storage.set).toHaveBeenCalledTimes(3));
    failed.reject(new Error("synthetic save failure"));
    await vi.waitFor(() => expect(t.storage.set).toHaveBeenCalledTimes(4)); await flush();
    expect(t.panel.root.textContent).toContain("not saved");
    expect(await t.storage.get()).toEqual({ "repotreex.preferences": { panelOpen: true, panelWidth: 300 } });
    recovered.resolve(undefined);
    await vi.waitFor(() => expect(t.panel.root.textContent).not.toContain("not saved"));
    expect(await t.storage.get()).toEqual({ "repotreex.preferences": { panelOpen: false, panelWidth: 300 } });
  });
});
