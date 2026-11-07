import { RepositoryError } from "../shared/errors";
import { buildBlobUrl, parseCnbRoute, type CnbRoute, type RepositoryRoute } from "../shared/route";
import { mountTreePanel, type PanelOptions, type PanelState, type TreePanel } from "./panel";
import type { Preferences, PreferenceStore } from "./preferences";
import type { RefOption, RepositoryProvider } from "./provider";
import { loadFullTree } from "./search";
import type { TreeDirectoryError, TreeStore } from "./tree-store";

export interface RepoTreeController {
  start(): Promise<void>;
  handleNavigation(url: URL): Promise<void>;
  destroy(): void;
}

export interface ControllerDependencies {
  window: Window;
  provider: RepositoryProvider;
  store: TreeStore;
  preferences: PreferenceStore;
  getUrl?: () => URL;
  navigate?: (href: string) => void;
  mountPanel?: (options: PanelOptions) => TreePanel;
}

function panelError(error: unknown): TreeDirectoryError {
  return { code: error instanceof RepositoryError ? error.code : "compatibility" };
}
function isAuth(error: TreeDirectoryError): boolean {
  return error.code === "signed-out" || error.code === "forbidden";
}
type FailureOwner = { kind: "directory" | "reveal"; path: string } | { kind: "full-tree" };

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new RepositoryError("cancelled"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// Encoded slash refs need a provisional hint to discover the repo. The final
// route must still match a discovered ref (or HEAD), never this URL-only hint.
function provisionalRoute(url: URL): CnbRoute {
  const parsed = parseCnbRoute(url);
  if (parsed.kind !== "unsupported") return parsed;
  const segment = url.pathname.split("/-/blob/")[1]?.split("/")[0];
  if (segment === undefined) return parsed;
  try {
    return parseCnbRoute(url, { knownRef: decodeURIComponent(segment) });
  } catch (error) {
    if (error instanceof URIError) return parsed;
    throw error;
  }
}

function reconcile(url: URL, refs: readonly RefOption[], head: string): CnbRoute {
  const route = parseCnbRoute(url);
  const candidates = [...new Set([head, ...refs.map((ref) => ref.name)])]
    .sort((left, right) => right.length - left.length);
  for (const name of candidates) {
    const candidate = parseCnbRoute(url, { knownRef: name });
    if (candidate.kind === "blob" && candidate.ref === name) return candidate;
  }
  // A simple provisional ref can be an unlisted SHA. Unknown encoded slash
  // refs fail closed because they have no independently established boundary.
  return route;
}

function refRootUrl(route: RepositoryRoute, ref: string): URL {
  const result = buildBlobUrl(route, ref, "__repotreex_root__");
  result.pathname = result.pathname.slice(0, -"/__repotreex_root__".length);
  return result;
}

export function createRepoTreeController(dependencies: ControllerDependencies): RepoTreeController {
  const { window, provider, store, preferences } = dependencies;
  const getUrl = dependencies.getUrl ?? (() => new URL(window.location.href));
  const navigate = dependencies.navigate ?? ((href: string) => window.location.assign(href));
  let panel: TreePanel | null = null;
  let route: RepositoryRoute | null = null;
  let lastUrl: string | null = null;
  let refs: RefOption[] = [];
  let head = "HEAD";
  let refsRepo: string | null = null;
  let generation = 0;
  let sessionVersion = 0;
  let destroyed = false;
  let loading = false;
  let error: TreeDirectoryError | null = null;
  const directoryErrors = new Map<string, TreeDirectoryError>();
  let revealError: { path: string; token: number; error: TreeDirectoryError } | null = null;
  let query = "";
  let discovery: AbortController | null = null;
  let navigation: AbortController | null = null;
  let traversal: AbortController | null = null;
  let fullTree: PanelState["fullTree"];
  let panelPreferences: Preferences = { panelOpen: true, panelWidth: 300 };
  let preferenceLoad: Promise<void> | null = null;
  let preferenceSaves: Promise<void> = Promise.resolve();
  let preferenceRevision = 0;
  let preferenceNotice: "preferences-load-failed" | "preferences-save-failed" | null = null;
  let routeNotice: "path-not-found" | "head-fallback" | null = null;
  let headFallback = false;
  let rateLimited = false;

  const current = (token: number) => !destroyed && token === generation;
  const render = () => {
    if (destroyed || !panel) return;
    panel.render({ snapshot: store.getSnapshot(), refs, query, loading,
      error: error ?? revealError?.error ?? [...directoryErrors.values()].at(-1) ?? null, fullTree,
      fullTreeDisabled: rateLimited || loading,
      notices: [routeNotice, preferenceNotice].filter((notice) => notice !== null),
    });
  };
  const cancelTraversal = (showResult = false) => {
    traversal?.abort(); traversal = null;
    fullTree = showResult ? { loading: false, result: { loadedNodes: Object.keys(store.getSnapshot().nodesByPath).length - 1,
      truncated: false, cancelled: true } } : undefined;
  };
  const clear = () => {
    sessionVersion++;
    // Drop controller state before store publication can render the outgoing refs.
    route = null; refs = []; refsRepo = null; head = "HEAD"; headFallback = false;
    query = ""; routeNotice = null; error = null; fullTree = undefined;
    directoryErrors.clear(); revealError = null;
    panel?.clearSensitiveData(); store.clearSensitiveData();
  };
  const failure = (value: unknown, token: number, owner?: FailureOwner) => {
    if (!current(token)) return;
    const next = panelError(value);
    if (next.code === "cancelled") return;
    if (isAuth(next)) {
      discovery?.abort(); cancelTraversal(); clear(); lastUrl = null;
      error = next; loading = false;
    } else {
      rateLimited ||= next.code === "rate-limited";
      if (owner?.kind === "full-tree") fullTree = { loading: false, error: next };
      else if (owner?.kind === "directory") directoryErrors.set(owner.path, next);
      else if (owner?.kind === "reveal") revealError = { path: owner.path, token, error: next };
      else error = next;
    }
    render();
  };
  const loadPreferences = () => {
    preferenceLoad ??= preferences.load().then(
      (value) => { if (!destroyed) panelPreferences = value; },
      () => { if (!destroyed) preferenceNotice = "preferences-load-failed"; },
    );
    return preferenceLoad;
  };
  const savePreferences = (patch: Partial<Preferences>) => {
    // Serialize read/modify/write saves; the storage contract itself is not a queue.
    const safePatch = {
      ...(typeof patch.panelOpen === "boolean" ? { panelOpen: patch.panelOpen } : {}),
      ...(typeof patch.panelWidth === "number" ? { panelWidth: patch.panelWidth } : {}),
    };
    panelPreferences = { ...panelPreferences, ...safePatch };
    const intended = { ...panelPreferences };
    const revision = ++preferenceRevision;
    preferenceSaves = preferenceSaves.then(async () => {
      if (destroyed) return;
      try {
        const saved = await preferences.save(intended);
        if (!destroyed && revision === preferenceRevision) {
          panelPreferences = saved; preferenceNotice = null; render();
        }
      } catch {
        // Storage errors can contain arbitrary values. Show only a fixed notice.
        if (!destroyed) { preferenceNotice = "preferences-save-failed"; render(); }
      }
    });
  };
  const runDirectory = async (path: string, toggle: boolean) => {
    const session = sessionVersion;
    if (!route || destroyed) return;
    const token = generation;
    const priorError = directoryErrors.get(path);
    const blockedReveal = revealError;
    try {
      if (toggle) await store.toggleDirectory(path);
      else await store.loadDirectory(path);
      if (destroyed || session !== sessionVersion) return;
      if (store.getSnapshot().nodesByPath[path]?.loaded) {
        if (directoryErrors.get(path) === priorError) directoryErrors.delete(path);
        if (blockedReveal?.path === path && blockedReveal.token === token && revealError === blockedReveal && current(token)) {
          revealError = null; loading = true; render();
          try { await reveal(token, getUrl()); }
          finally { if (current(token)) loading = false; }
        }
      }
      render();
    } catch (value) {
      if (!destroyed && session === sessionVersion) failure(value, generation, { kind: "directory", path });
    }
  };
  const observeSessionLoad = async (work: Promise<void>, session: number) => {
    try { await work; }
    catch (value) {
      if (!destroyed && session === sessionVersion) {
        const next = panelError(value);
        if (isAuth(next)) failure(value, generation);
        // Session-wide throttling outlives the navigation/traversal that issued
        // the shared load. Never attach its outgoing path to the new reveal.
        else if (next.code === "rate-limited") { rateLimited = true; render(); }
      }
      throw value;
    }
  };
  const startTraversal = async (retry = false) => {
    if (destroyed || !route || traversal || loading || rateLimited && !retry) return;
    if (retry) rateLimited = false;
    const token = generation; const controller = new AbortController(); traversal = controller;
    const session = sessionVersion;
    fullTree = { loading: true }; render();
    try {
      const result = await loadFullTree({ getSnapshot: store.getSnapshot,
        loadDirectory: (path) => observeSessionLoad(store.loadDirectory(path), session),
      }, { signal: controller.signal, onProgress(progress) {
        if (current(token) && traversal === controller) { fullTree = { loading: true, progress }; render(); }
      } });
      if (current(token) && traversal === controller) { fullTree = { loading: false, result }; render(); }
    } catch (value) {
      if (traversal === controller) failure(value, token, { kind: "full-tree" });
    } finally { if (traversal === controller) traversal = null; }
  };
  const mount = () => {
    panel ??= (dependencies.mountPanel ?? mountTreePanel)({ document: window.document, preferences: panelPreferences,
      onOpenFile(path) {
        if (!route || !route.ref || destroyed) return;
        const node = store.getSnapshot().nodesByPath[path];
        if (!node || node.kind === "directory") { failure(new RepositoryError("not-found"), generation); return; }
        try { navigate(buildBlobUrl(route, route.ref, path).href); }
        catch (value) { failure(value, generation); }
      },
      onToggleDirectory: (path) => { void runDirectory(path, true); },
      onRetryDirectory(path) { rateLimited = false; void runDirectory(path, false); },
      onRefresh: () => { void refresh(); },
      onSearch(value) { if (destroyed || !route) return; query = value; render(); },
      onLoadFullTree: () => { void startTraversal(); },
      onRetryFullTree: () => { void startTraversal(true); },
      onCancelFullTree() { cancelTraversal(true); render(); },
      onSelectRef(ref) {
        if (!route || destroyed || !refs.some((option) => option.name === ref)) return;
        const file = route.filePath && store.getSnapshot().nodesByPath[route.filePath];
        const path = route.filePath && (!file || file.kind !== "directory") ? route.filePath : null;
        try { navigate((path ? buildBlobUrl(route, ref, path) : refRootUrl(route, ref)).href); }
        catch (value) { failure(value, generation); }
      },
      onPreferenceChange: savePreferences,
    });
  };
  const reveal = async (token: number, url: URL) => {
    if (!route?.ref) return;
    const active = route;
    const session = sessionVersion;
    const path = active.filePath;
    let parent = "";
    let rootLoaded = false;
    try {
      await observeSessionLoad(store.loadDirectory(""), session);
      if (!current(token)) return;
      rootLoaded = true;
      if (!path) { store.selectPath(null); return; }
      const ancestors = path.split("/").slice(0, -1);
      for (const segment of ancestors) {
        parent = parent ? `${parent}/${segment}` : segment;
        const node = store.getSnapshot().nodesByPath[parent];
        if (!node || node.kind !== "directory") throw new RepositoryError("not-found");
        await observeSessionLoad(node.expanded ? store.loadDirectory(parent) : store.toggleDirectory(parent), session);
        if (!current(token)) return;
      }
      const target = store.getSnapshot().nodesByPath[path];
      if (target?.kind === "directory") {
        parent = path;
        await observeSessionLoad(target.expanded ? store.loadDirectory(path) : store.toggleDirectory(path), session);
        if (!current(token)) return;
      }
      store.selectPath(path);
    } catch (value) {
      if (!current(token)) return;
      if (!rootLoaded || !(value instanceof RepositoryError) || value.code !== "not-found") {
        failure(value, token, { kind: "reveal", path: parent }); return;
      }
      store.selectPath(null); route = { ...active, filePath: null }; routeNotice = "path-not-found";
      const fallback = refRootUrl(active, active.ref ?? head); fallback.hash = "repotreex-path-not-found";
      if (url.href !== fallback.href) navigate(fallback.href);
    }
  };
  const handleNavigation = async (url: URL, force = false) => {
    if (destroyed || !force && lastUrl === url.href) return;
    const token = ++generation; lastUrl = url.href;
    navigation?.abort(); navigation = new AbortController();
    const signal = navigation.signal;
    discovery?.abort(); discovery = null; cancelTraversal(); error = null;
    directoryErrors.clear(); revealError = null;
    const provisional = provisionalRoute(url);
    if (provisional.kind === "unsupported") {
      loading = false; clear(); panel?.destroy(); panel = null; return;
    }
    const previous = route;
    const repo = provisional.repo;
    const cached = refsRepo === provisional.repo;
    const cachedRefs = refs; const cachedHead = head; const cachedFallback = headFallback;
    const stable = cached ? reconcile(url, refs, head) : provisional;
    const sameSession = stable.kind !== "unsupported" && previous?.repo === stable.repo && previous.ref === (stable.ref ?? head)
      && store.getSnapshot().repo !== null;
    if (!sameSession) { clear(); rateLimited = false; }
    else { store.selectPath(null); routeNotice = null; }
    if (cached) { refs = cachedRefs; head = cachedHead; headFallback = cachedFallback; refsRepo = repo; }
    loading = true;
    // Begin requests before preference I/O, but mount only after preferences settle.
    const abort = new AbortController(); discovery = abort;
    const discover = async () => {
      if (cached) return;
      const discovered = await Promise.all([
        provider.getHead(repo, abort.signal).catch((value: unknown) => {
          if (value instanceof RepositoryError && value.code === "not-found") return null;
          throw value;
        }),
        provider.listBranches(repo, abort.signal), provider.listTags(repo, abort.signal),
      ]);
      if (!current(token)) return;
      head = discovered[0] ?? "HEAD"; headFallback = discovered[0] === null;
      refs = [...discovered[1], ...discovered[2]]; refsRepo = repo;
    };
    // Observe discovery immediately; preference storage may remain pending.
    const resolution = discover().then(() => null, (value: unknown) => {
      if (current(token)) abort.abort();
      return { value };
    });
    try {
      await untilAborted(loadPreferences(), signal);
      if (!current(token)) return;
      mount(); render();
      const outcome = await untilAborted(resolution, signal);
      if (!current(token)) return;
      if (outcome) throw outcome.value;
      const resolved = reconcile(url, refs, head);
      if (resolved.kind === "unsupported") { clear(); panel?.destroy(); panel = null; return; }
      route = { ...resolved, ref: resolved.ref ?? head };
      routeNotice = url.hash === "#repotreex-path-not-found" ? "path-not-found" : headFallback ? "head-fallback" : null;
      if (!sameSession) store.startSession(route.repo, route.ref ?? head);
      await untilAborted(reveal(token, url), signal);
    } catch (value) { failure(value, token); }
    finally { if (current(token)) { loading = false; render(); } }
  };
  const refresh = async () => {
    if (destroyed) return;
    if (!route?.ref) { lastUrl = null; await handleNavigation(getUrl(), true); return; }
    const token = ++generation; sessionVersion++; navigation?.abort(); navigation = null;
    cancelTraversal(); discovery?.abort(); discovery = null;
    rateLimited = false; error = null; loading = true; query = "";
    directoryErrors.clear(); revealError = null;
    panel?.clearSensitiveData(); store.startSession(route.repo, route.ref);
    try { await reveal(token, getUrl()); }
    catch (value) { failure(value, token); }
    finally { if (current(token)) { loading = false; render(); } }
  };
  const unsubscribe = store.subscribe(() => {
    // The store clears synchronously on auth, before promise reactions run.
    if (store.getSnapshot().repo === null) panel?.clearSensitiveData();
    else render();
  });
  return {
    start: () => handleNavigation(getUrl()), handleNavigation,
    destroy() {
      if (destroyed) return;
      destroyed = true; generation++; sessionVersion++; navigation?.abort(); navigation = null;
      discovery?.abort(); discovery = null; cancelTraversal();
      unsubscribe(); const outgoingPanel = panel; panel = null;
      route = null; refs = []; refsRepo = null; query = ""; lastUrl = null; error = null;
      directoryErrors.clear(); revealError = null;
      const failures: unknown[] = [];
      try { outgoingPanel?.destroy(); } catch (value) { failures.push(value); }
      try { store.dispose(); } catch (value) { failures.push(value); }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Controller disposal failed");
    },
  };
}
