import css from "./panel.css?raw";
import { createPanelIcon, type PanelIcon } from "./icons";
import type { Preferences } from "./preferences";
import type { RefOption } from "./provider";
import { matchLoadedNodes, type TraversalProgress, type TraversalResult } from "./search";
import type { TreeDirectoryError, TreeNode, TreeSnapshot } from "./tree-store";

export interface PanelOptions {
  document: Document;
  preferences?: Preferences;
  onOpenFile(path: string): void;
  onToggleDirectory(path: string): void;
  onRefresh(): void;
  onSearch(query: string): void;
  onLoadFullTree(): void;
  onCancelFullTree?(): void;
  onSelectRef(ref: string): void;
  onRetryDirectory?(path: string): void;
  onPreferenceChange(patch: Partial<Preferences>): void;
}

export interface PanelState {
  snapshot: TreeSnapshot;
  refs?: readonly RefOption[];
  query?: string;
  loading?: boolean;
  error?: TreeDirectoryError | null;
  fullTree?: Readonly<{
    loading: boolean;
    progress?: TraversalProgress;
    result?: TraversalResult;
    error?: TreeDirectoryError | null;
  }>;
}

export interface TreePanel {
  readonly host: HTMLElement;
  readonly root: ShadowRoot;
  render(state: PanelState): void;
  focusPath(path: string): void;
  clearSensitiveData(): void;
  destroy(): void;
}

const mountedPanels = new WeakMap<Document, TreePanel>();
const MIN_WIDTH = 240;
const MAX_WIDTH = 560;
const LAYOUT_CLASS = "repotreex-panel-open";
const messages: Record<TreeDirectoryError["code"], string> = {
  "signed-out": "CNB login expired. Sign in to view the repository.",
  forbidden: "Repository access denied. Check your CNB permissions.",
  "not-found": "Repository, ref or path not found.",
  "rate-limited": "Request rate limited. Try again later.",
  server: "CNB is unavailable. Try again.",
  network: "Network request failed. Try again.",
  compatibility: "CNB response is incompatible. Try again after refreshing.",
  cancelled: "Request cancelled.",
};

function clampedWidth(value: number): number {
  return Number.isFinite(value) ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value)) : 300;
}

export function mountTreePanel(options: PanelOptions): TreePanel {
  const document = options.document;
  const existing = mountedPanels.get(document);
  if (existing) return existing;
  const window = document.defaultView;
  if (!window) throw new TypeError("Panel requires a window-backed document");
  if (document.getElementById("repotreex-root")) throw new Error("Panel host already exists");
  const html = document.documentElement;
  const priorFocus = document.activeElement instanceof window.HTMLElement ? document.activeElement : null;
  const priorProperties = ["--repotreex-panel-width", "--repotreex-page-padding-left"].map((name) => ({
    name, value: html.style.getPropertyValue(name), priority: html.style.getPropertyPriority(name),
  }));
  const priorClass = html.classList.contains(LAYOUT_CLASS);
  let callbacks: PanelOptions | null = options;
  let open = options.preferences?.panelOpen ?? true;
  let width = clampedWidth(options.preferences?.panelWidth ?? 300);
  let disposed = false;
  let state: PanelState | null = null;
  let queued: PanelState | null = null;
  let frame: number | null = null;
  let query = "";
  let focusPath: string | null = null;
  let focusRequested = false;
  let rows: HTMLElement[] = [];
  let visible: readonly TreeNode[] = [];
  let drag: { pointerId: number; startX: number; startWidth: number } | null = null;

  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
    const result = document.createElement(tag);
    if (className) result.className = className;
    return result;
  };
  const button = (label: string, icon?: PanelIcon): HTMLButtonElement => {
    const result = element("button", icon ? "icon-button" : undefined);
    result.type = "button";
    result.setAttribute("aria-label", label);
    result.title = label;
    if (icon) result.append(createPanelIcon(document, icon));
    else result.textContent = label;
    return result;
  };
  const host = element("div");
  host.id = "repotreex-root";
  const root = host.attachShadow({ mode: "closed" });
  const style = element("style"); style.textContent = css;
  const backdrop = button("Close repository tree overlay"); backdrop.className = "backdrop"; backdrop.tabIndex = -1;
  const region = element("section", "panel"); region.id = "repotreex-panel";
  region.setAttribute("role", "region"); region.setAttribute("aria-label", "Repository explorer");
  const header = element("header", "header");
  const brandRow = element("div", "brand-row");
  const brand = element("span", "brand"); brand.textContent = "RepoTreeX";
  const refresh = button("Refresh repository tree", "refresh");
  const collapse = button("Collapse repository tree", "close");
  brandRow.append(brand, refresh, collapse);
  const repository = element("span", "repository");
  const refRow = element("div", "ref-row"); const refIcon = createPanelIcon(document, "branch");
  const ref = element("select"); ref.setAttribute("aria-label", "Repository ref");
  refRow.append(refIcon, ref); header.append(brandRow, repository, refRow);
  const body = element("div", "body");
  const searchBox = element("div", "search-box"); const search = element("input");
  search.type = "search"; search.placeholder = "Find a file or path"; search.autocomplete = "off";
  search.spellcheck = false; search.setAttribute("aria-label", "Search repository paths");
  searchBox.append(createPanelIcon(document, "search"), search);
  const fullSearch = button("Load full tree for search"); fullSearch.className = "full-search";
  const status = element("div", "status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const error = element("div", "error"); error.setAttribute("role", "alert"); error.hidden = true;
  const tree = element("ul", "tree"); tree.setAttribute("role", "tree"); tree.setAttribute("aria-label", "Repository files");
  body.append(searchBox, fullSearch, status, error, tree); region.append(header, body);
  const reopen = button("Open repository tree"); reopen.className = "reopen"; reopen.textContent = "RepoTreeX";
  reopen.setAttribute("aria-controls", region.id);
  const resizer = element("div", "resizer"); resizer.tabIndex = 0;
  resizer.setAttribute("role", "separator"); resizer.setAttribute("aria-orientation", "vertical");
  resizer.setAttribute("aria-label", "Resize repository tree");
  resizer.setAttribute("aria-valuemin", String(MIN_WIDTH)); resizer.setAttribute("aria-valuemax", String(MAX_WIDTH));
  root.append(style, backdrop, region, reopen, resizer);
  const layoutStyle = element("style"); layoutStyle.dataset.repotreexLayout = "";
  layoutStyle.textContent = `html.${LAYOUT_CLASS} { padding-left: calc(var(--repotreex-page-padding-left, 0px) + var(--repotreex-panel-width, 300px)) !important; }`;
  // Only two dedicated properties and one class touch CNB; inline padding is never overwritten.
  html.style.setProperty("--repotreex-page-padding-left", window.getComputedStyle(html).paddingLeft || "0px");
  html.append(layoutStyle, host);

  const updateLayout = () => {
    if (disposed) return;
    const overlay = window.innerWidth < 800;
    host.dataset.overlay = String(overlay); host.dataset.open = String(open);
    html.style.setProperty("--repotreex-panel-width", `${width}px`);
    host.style.setProperty("--repotreex-panel-width", `${width}px`);
    region.hidden = !open; reopen.hidden = open; resizer.hidden = !open;
    reopen.setAttribute("aria-expanded", String(open));
    backdrop.hidden = !open || !overlay;
    resizer.setAttribute("aria-valuenow", String(width));
    html.classList.toggle(LAYOUT_CLASS, open && !overlay);
    let offset = 0;
    for (const candidate of document.querySelectorAll<HTMLElement>('header, [role="banner"]')) {
      const position = window.getComputedStyle(candidate).position;
      const bounds = candidate.getBoundingClientRect();
      if ((position === "fixed" || position === "sticky") && bounds.top <= 1 && bounds.bottom > 0 && bounds.bottom <= 160) {
        offset = Math.max(offset, bounds.bottom);
      }
    }
    host.style.setProperty("--repotreex-top-offset", `${offset}px`);
  };

  const darkMedia = window.matchMedia?.("(prefers-color-scheme: dark)");
  const updateTheme = () => {
    if (disposed) return;
    const explicit = html.getAttribute("data-theme") ?? document.body?.getAttribute("data-theme");
    const scheme = window.getComputedStyle(html).colorScheme;
    const dark = explicit === "dark" || explicit !== "light" && (scheme === "dark" || scheme !== "light" && darkMedia?.matches);
    host.dataset.theme = dark ? "dark" : "light";
  };
  const observer = new window.MutationObserver(updateTheme);
  observer.observe(html, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
  if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
  darkMedia?.addEventListener("change", updateTheme);

  // Scrub descendants before detaching, including nodes held by a caller/test.
  const scrub = (container: HTMLElement) => {
    const walker = document.createTreeWalker(container, window.NodeFilter.SHOW_ALL);
    const descendants: Node[] = [];
    while (walker.nextNode()) descendants.push(walker.currentNode);
    for (const child of descendants) {
      if (child.nodeType === window.Node.TEXT_NODE) child.nodeValue = "";
      if (child instanceof window.Element) {
        child.removeAttribute("data-path"); child.removeAttribute("title"); child.removeAttribute("aria-label");
        if (child instanceof window.HTMLInputElement) child.value = "";
        if (child instanceof window.HTMLOptionElement) { child.value = ""; child.textContent = ""; }
        child.replaceChildren();
      }
    }
    container.replaceChildren();
  };
  const clearSensitiveData = () => {
    const hadPanelFocus = root.activeElement !== null && root.activeElement !== reopen;
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null; queued = null; state = null; query = ""; focusPath = null; focusRequested = false;
    visible = []; rows = [];
    scrub(tree); scrub(ref); scrub(error);
    search.value = ""; scrub(repository); repository.removeAttribute("title");
    refIcon.replaceChildren(createPanelIcon(document, "branch").firstChild ?? document.createTextNode(""));
    scrub(status); error.hidden = true;
    tree.setAttribute("aria-busy", "false"); tree.tabIndex = 0;
    ref.disabled = true; refresh.disabled = true; search.disabled = true; fullSearch.disabled = true;
    if (hadPanelFocus && open) tree.focus();
  };

  const focusRow = (path: string | null) => {
    const next = rows.find((item) => item.dataset.path === path);
    if (!next || !open) return;
    focusPath = path;
    for (const item of rows) item.tabIndex = item === next ? 0 : -1;
    next.focus(); next.scrollIntoView({ block: "nearest", behavior: "auto" });
  };
  const activate = (path: string) => {
    const entry = visible.find((candidate) => candidate.path === path);
    if (!entry) return;
    focusRow(path);
    if (entry.kind === "directory") callbacks?.onToggleDirectory(path);
    else callbacks?.onOpenFile(path);
  };

  const renderNow = () => {
    frame = null;
    if (disposed || !queued) return;
    const previousSelection = state?.snapshot.selectedPath;
    state = queued; queued = null;
    const snapshot = state.snapshot;
    const active = root.activeElement;
    const restoreFocus = focusRequested || active instanceof window.HTMLElement && active.getAttribute("role") === "treeitem";
    if (!restoreFocus && previousSelection !== snapshot.selectedPath) focusPath = snapshot.selectedPath;
    if (!focusRequested && active instanceof window.HTMLElement && active.getAttribute("role") === "treeitem") focusPath = active.dataset.path ?? null;
    focusRequested = false;
    query = state.query ?? query; search.value = query;
    const activeSession = snapshot.repo !== null && snapshot.ref !== null;
    const rootNode = snapshot.nodesByPath[""];
    const failure = state.error ?? rootNode?.error;
    const busy = Boolean(state.loading || rootNode?.loading || state.fullTree?.loading);
    const loadedMatches = query.trim() ? matchLoadedNodes(snapshot, query) : null;
    visible = loadedMatches ?? snapshot.visibleNodes;
    repository.textContent = snapshot.repo?.split("/").at(-1) ?? "";
    scrub(ref);
    const refs = state.refs ?? [];
    for (const kind of ["branch", "tag"] as const) {
      const group = element("optgroup"); group.label = kind === "branch" ? "Branches" : "Tags";
      for (const option of refs) if (option.kind === kind) {
        const item = element("option"); item.value = option.name; item.textContent = option.name; group.append(item);
      }
      if (group.childElementCount) ref.append(group);
    }
    if (activeSession && !refs.some((option) => option.name === snapshot.ref)) {
      const current = element("option"); current.value = snapshot.ref ?? ""; current.textContent = snapshot.ref; ref.prepend(current);
    }
    ref.value = snapshot.ref ?? "";
    const selectedRef = refs.find((option) => option.name === snapshot.ref);
    refIcon.replaceChildren(createPanelIcon(document, selectedRef?.kind ?? "branch").firstChild ?? document.createTextNode(""));
    ref.disabled = !activeSession; refresh.disabled = !activeSession || Boolean(state.loading);
    search.disabled = !activeSession;
    fullSearch.disabled = !activeSession || Boolean(state.fullTree?.loading && !callbacks?.onCancelFullTree);
    const fullLoading = state.fullTree?.loading;
    fullSearch.setAttribute("aria-label", fullLoading ? "Cancel full-tree search" : "Load full tree for search");
    fullSearch.textContent = fullLoading ? "Cancel full-tree search" : "Load full tree for search";
    const progress = state.fullTree?.progress;
    status.textContent = fullLoading && progress
      ? `Loading full tree: ${progress.loadedNodes} paths; ${progress.queuedDirectories} queued; ${progress.activeRequests} active.`
      : busy ? "Loading repository tree..."
      : !activeSession ? "Open a supported CNB repository."
      : failure && failure.code !== "cancelled" ? ""
      : visible.length === 0 ? query.trim() ? "No matching paths"
        : rootNode?.loaded ? "This repository is empty" : "Waiting for repository tree..." : "";
    if (state.fullTree?.result?.truncated) status.textContent += "\nSearch is incomplete: the full-tree limit was reached.";
    if (state.fullTree?.result?.cancelled) status.textContent += "\nFull-tree search cancelled; only loaded paths are searched.";
    if (loadedMatches?.hasMoreMatches) status.textContent += "\nMore matches exist. Showing the first 200; narrow your search.";
    scrub(error); error.hidden = !failure && !state.fullTree?.error;
    const shownError = failure ?? state.fullTree?.error;
    if (shownError && shownError.code !== "cancelled") {
      const text = element("span"); text.textContent = messages[shownError.code]; error.append(text);
      const retry = button(failure ? "Retry repository tree" : "Retry full-tree search");
      retry.dataset.action = failure ? "retry-root" : "retry-full"; error.append(retry);
    } else error.hidden = true;
    tree.setAttribute("aria-busy", String(busy));
    scrub(tree); rows = [];
    const fragment = document.createDocumentFragment();
    const siblingGroups = new Map<string | null, TreeNode[]>();
    for (const entry of visible) {
      const parent = query.trim() ? null : entry.parentPath;
      const group = siblingGroups.get(parent) ?? [];
      group.push(entry); siblingGroups.set(parent, group);
    }
    const positions = new Map<string, number>();
    for (const group of siblingGroups.values()) group.forEach((entry, index) => positions.set(entry.path, index + 1));
    for (const entry of visible) {
      const item = element("li", "item"); item.dataset.path = entry.path; item.tabIndex = -1;
      item.setAttribute("role", "treeitem"); item.setAttribute("aria-label", query.trim() ? entry.path : entry.name);
      item.setAttribute("aria-selected", String(snapshot.selectedPath === entry.path));
      const level = query.trim() ? 1 : entry.depth;
      item.setAttribute("aria-level", String(level)); item.style.setProperty("--level", String(level));
      item.setAttribute("aria-posinset", String(positions.get(entry.path)));
      item.setAttribute("aria-setsize", String(siblingGroups.get(query.trim() ? null : entry.parentPath)?.length ?? 1));
      if (entry.kind === "directory") {
        item.setAttribute("aria-expanded", String(entry.expanded)); item.setAttribute("aria-busy", String(entry.loading));
        const chevron = createPanelIcon(document, "chevron"); chevron.classList.add("chevron"); item.append(chevron);
      } else item.append(element("span", "spacer"));
      item.append(createPanelIcon(document, entry.kind === "directory" ? "folder" : entry.kind));
      const label = element("span", "label"); label.textContent = query.trim() ? entry.path : entry.name; item.append(label);
      if (entry.loading) { const loading = element("span", "directory-status"); loading.textContent = "Loading"; item.append(loading); }
      rows.push(item); fragment.append(item);
      if (entry.error && entry.error.code !== "cancelled") {
        const rowError = element("li", "directory-error"); rowError.setAttribute("role", "none");
        const message = element("span"); message.setAttribute("role", "alert"); message.textContent = messages[entry.error.code];
        const retry = button("Retry directory"); retry.dataset.path = entry.path; retry.dataset.action = "retry-directory";
        rowError.append(message, retry); fragment.append(rowError);
      }
    }
    tree.append(fragment); tree.tabIndex = rows.length ? -1 : 0;
    while (focusPath && !rows.some((item) => item.dataset.path === focusPath)) {
      focusPath = snapshot.nodesByPath[focusPath]?.parentPath || (focusPath.includes("/") ? focusPath.slice(0, focusPath.lastIndexOf("/")) : null);
    }
    focusPath ??= rows.find((item) => item.dataset.path === snapshot.selectedPath)?.dataset.path ?? rows[0]?.dataset.path ?? null;
    for (const item of rows) item.tabIndex = item.dataset.path === focusPath ? 0 : -1;
    if (restoreFocus) {
      if (rows.length) focusRow(focusPath);
      else if (open) tree.focus();
    }
    if (snapshot.selectedPath) rows.find((item) => item.dataset.path === snapshot.selectedPath)?.scrollIntoView({ block: "nearest", behavior: "auto" });
    updateLayout();
  };
  const schedule = () => {
    if (disposed || frame !== null) return;
    frame = window.requestAnimationFrame(renderNow);
  };
  const setOpen = (next: boolean) => {
    if (disposed || next === open) return;
    open = next; updateLayout();
    if (open) { if (rows.length) focusRow(focusPath); else tree.focus(); }
    else reopen.focus();
    callbacks?.onPreferenceChange({ panelOpen: open });
  };
  const onClick = (event: Event) => {
    event.stopPropagation();
    const target = event.target;
    if (!(target instanceof window.Element)) return;
    const action = target.closest<HTMLElement>("[data-action]");
    if (action?.dataset.action === "retry-root") { callbacks?.onRefresh(); return; }
    if (action?.dataset.action === "retry-full") { callbacks?.onLoadFullTree(); return; }
    if (action?.dataset.action === "retry-directory" && action.dataset.path !== undefined) {
      if (callbacks?.onRetryDirectory) callbacks.onRetryDirectory(action.dataset.path);
      else callbacks?.onToggleDirectory(action.dataset.path);
      return;
    }
    const item = target.closest<HTMLElement>('[role="treeitem"][data-path]');
    if (item?.dataset.path !== undefined) activate(item.dataset.path);
    else if (target.closest("button") === collapse || target === backdrop) setOpen(false);
    else if (target.closest("button") === reopen) setOpen(true);
    else if (target.closest("button") === refresh) callbacks?.onRefresh();
    else if (target.closest("button") === fullSearch) {
      if (state?.fullTree?.loading) callbacks?.onCancelFullTree?.();
      else callbacks?.onLoadFullTree();
    }
  };
  const onKey = (rawEvent: Event) => {
    if (!(rawEvent instanceof window.KeyboardEvent)) return;
    const event = rawEvent;
    event.stopPropagation();
    const target = event.target;
    if (!(target instanceof window.HTMLElement)) return;
    if (target === resizer) {
      let next = width;
      if (event.key === "ArrowRight") next += 16;
      else if (event.key === "ArrowLeft") next -= 16;
      else if (event.key === "Home") next = MIN_WIDTH;
      else if (event.key === "End") next = MAX_WIDTH;
      else return;
      event.preventDefault(); width = clampedWidth(next); updateLayout(); callbacks?.onPreferenceChange({ panelWidth: width }); return;
    }
    if (target === search && event.key === "Escape" && query !== "") {
      event.preventDefault(); event.stopPropagation(); search.value = ""; query = "";
      queued = { ...(queued ?? state ?? emptyState()), query }; schedule(); callbacks?.onSearch(""); return;
    }
    if (event.key === "Escape" && window.innerWidth < 800 && open) { event.preventDefault(); setOpen(false); return; }
    const path = target.dataset.path;
    if (path === undefined || target.getAttribute("role") !== "treeitem") return;
    const index = visible.findIndex((entry) => entry.path === path); const entry = visible[index];
    if (!entry) return;
    let next: string | null = null;
    switch (event.key) {
      case "ArrowDown": next = visible[Math.min(index + 1, visible.length - 1)].path; break;
      case "ArrowUp": next = visible[Math.max(index - 1, 0)].path; break;
      case "Home": next = visible[0].path; break;
      case "End": next = visible[visible.length - 1].path; break;
      case "ArrowRight":
        if (entry.kind === "directory") {
          if (!entry.expanded) callbacks?.onToggleDirectory(path);
          else next = visible.find((candidate) => candidate.parentPath === path)?.path ?? null;
        }
        break;
      case "ArrowLeft":
        if (entry.kind === "directory" && entry.expanded) callbacks?.onToggleDirectory(path);
        else next = entry.parentPath;
        break;
      case "Enter": case " ": activate(path); break;
      default: return;
    }
    event.preventDefault(); event.stopPropagation(); if (next) focusRow(next);
  };
  const onFocus = (event: Event) => {
    const target = event.target;
    if (target instanceof window.HTMLElement && target.getAttribute("role") === "treeitem") {
      focusPath = target.dataset.path ?? null;
      for (const item of rows) item.tabIndex = item === target ? 0 : -1;
    }
  };
  const onInput = (event: Event) => {
    event.stopPropagation();
    query = search.value; queued = { ...(queued ?? state ?? emptyState()), query }; schedule(); callbacks?.onSearch(query);
  };
  const onRef = (event: Event) => { event.stopPropagation(); callbacks?.onSelectRef(ref.value); };
  const onPointerDown = (event: PointerEvent) => {
    if (disposed || drag || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault(); resizer.setPointerCapture(event.pointerId);
    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: width }; host.dataset.resizing = "true";
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    width = clampedWidth(drag.startWidth + event.clientX - drag.startX); updateLayout();
  };
  const endDrag = (save: boolean, release = true) => {
    if (!drag) return;
    const current = drag; drag = null;
    if (!save) width = current.startWidth;
    host.removeAttribute("data-resizing");
    if (release) resizer.releasePointerCapture(current.pointerId);
    updateLayout(); if (save) callbacks?.onPreferenceChange({ panelWidth: width });
  };
  const onPointerUp = (event: PointerEvent) => { if (drag?.pointerId === event.pointerId) { onPointerMove(event); endDrag(true); } };
  const onPointerCancel = (event: PointerEvent) => { if (drag?.pointerId === event.pointerId) endDrag(false, event.type !== "lostpointercapture"); };
  root.addEventListener("click", onClick); root.addEventListener("keydown", onKey); root.addEventListener("focusin", onFocus);
  search.addEventListener("input", onInput); ref.addEventListener("change", onRef);
  resizer.addEventListener("pointerdown", onPointerDown); resizer.addEventListener("pointermove", onPointerMove);
  resizer.addEventListener("pointerup", onPointerUp); resizer.addEventListener("pointercancel", onPointerCancel);
  resizer.addEventListener("lostpointercapture", onPointerCancel);
  window.addEventListener("resize", updateLayout);
  const panel: TreePanel = {
    host, root,
    render(next) {
      if (disposed) return;
      const previous = queued ?? state;
      const authError = [next.error, next.snapshot.nodesByPath[""]?.error, next.fullTree?.error]
        .find((error) => error?.code === "signed-out" || error?.code === "forbidden");
      const authFailure = Boolean(authError);
      const inactive = next.snapshot.repo === null || next.snapshot.ref === null;
      const changed = previous && (previous.snapshot.repo !== next.snapshot.repo || previous.snapshot.ref !== next.snapshot.ref);
      if (authFailure || inactive || changed) clearSensitiveData();
      if (authFailure) {
        error.hidden = false; error.textContent = messages[authError?.code ?? "compatibility"];
        return;
      }
      queued = inactive ? {
        ...emptyState(),
        error: next.error ? { code: next.error.code } : null,
      } : next;
      schedule();
    },
    focusPath(path) {
      if (disposed) return;
      if (frame !== null) { focusPath = path; focusRequested = true; }
      else focusRow(path);
    },
    clearSensitiveData,
    destroy() {
      if (disposed) return;
      const restorePageFocus = document.activeElement === host;
      endDrag(false); clearSensitiveData(); disposed = true; callbacks = null;
      observer.disconnect(); darkMedia?.removeEventListener("change", updateTheme); window.removeEventListener("resize", updateLayout);
      root.removeEventListener("click", onClick); root.removeEventListener("keydown", onKey); root.removeEventListener("focusin", onFocus);
      search.removeEventListener("input", onInput); ref.removeEventListener("change", onRef);
      resizer.removeEventListener("pointerdown", onPointerDown); resizer.removeEventListener("pointermove", onPointerMove);
      resizer.removeEventListener("pointerup", onPointerUp); resizer.removeEventListener("pointercancel", onPointerCancel);
      resizer.removeEventListener("lostpointercapture", onPointerCancel);
      root.replaceChildren(); host.remove(); layoutStyle.remove();
      for (const property of priorProperties) {
        if (property.value) html.style.setProperty(property.name, property.value, property.priority);
        else html.style.removeProperty(property.name);
      }
      html.classList.toggle(LAYOUT_CLASS, priorClass); mountedPanels.delete(document);
      if (restorePageFocus && priorFocus?.isConnected) priorFocus.focus({ preventScroll: true });
    },
  };
  mountedPanels.set(document, panel); clearSensitiveData(); updateLayout(); updateTheme();
  return panel;
}

function emptyState(): PanelState {
  return { snapshot: { repo: null, ref: null, nodesByPath: {}, visibleNodes: [], expandedPaths: [], selectedPath: null } };
}
