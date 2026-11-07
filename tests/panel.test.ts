import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountTreePanel, type PanelOptions, type PanelState, type TreePanel } from "../src/content/panel";
import { createPreferenceStore } from "../src/content/preferences";
import type { TreeNode, TreeSnapshot } from "../src/content/tree-store";

const panels: TreePanel[] = [];
let frames: Map<number, FrameRequestCallback>;
let frameId: number;

function node(path: string, kind: TreeNode["kind"] = "file", patch: Partial<TreeNode> = {}): TreeNode {
  return {
    path, kind, name: path.split("/").at(-1) ?? "", sha: "synthetic-sha",
    parentPath: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    depth: path.split("/").length, childPaths: [], loaded: true, loading: false,
    expanded: false, selected: path === "src/app.ts", error: null, ...patch,
  };
}

function state(patch: Partial<PanelState> = {}): PanelState {
  const nodes = [
    node("src", "directory", { expanded: true, childPaths: ["src/app.ts", "src/other.ts"] }),
    node("src/app.ts"), node("src/other.ts"), node("README.md"),
    node("shortcut", "link"), node("vendor", "submodule"),
  ];
  const root = node("", "directory", {
    depth: 0, parentPath: null, childPaths: ["src", "README.md", "shortcut", "vendor"],
  });
  return {
    snapshot: {
      repo: "synthetic/team/demo", ref: "main", nodesByPath: Object.fromEntries([root, ...nodes].map((entry) => [entry.path, entry])),
      visibleNodes: nodes, expandedPaths: ["src"], selectedPath: "src/app.ts",
    },
    refs: [{ kind: "branch", name: "main", sha: "main-sha" }, { kind: "tag", name: "v1", sha: "tag-sha" }],
    ...patch,
  };
}

function setup(patch: Partial<PanelOptions> = {}) {
  const options: PanelOptions = {
    document, onOpenFile: vi.fn(), onToggleDirectory: vi.fn(), onRefresh: vi.fn(),
    onSearch: vi.fn(), onLoadFullTree: vi.fn(), onCancelFullTree: vi.fn(),
    onSelectRef: vi.fn(), onRetryDirectory: vi.fn(), onPreferenceChange: vi.fn(), ...patch,
  };
  const panel = mountTreePanel(options);
  panels.push(panel);
  return { panel, options };
}

function flush() {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(0);
}

function row(panel: TreePanel, path: string): HTMLElement {
  const result = [...panel.root.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((item) => item.dataset.path === path);
  if (!result) throw new Error("Expected synthetic tree row");
  return result;
}

function control<T extends HTMLElement = HTMLButtonElement>(panel: TreePanel, label: string): T {
  const result = panel.root.querySelector<T>(`[aria-label="${label}"]`);
  if (!result) throw new Error("Expected panel control");
  return result;
}

function key(target: HTMLElement, value: string) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
}

function pointer(target: HTMLElement, type: string, x: number) {
  const event = new MouseEvent(type, { clientX: x, button: 0, bubbles: true, cancelable: true });
  Object.defineProperties(event, { pointerId: { value: 7 }, isPrimary: { value: true } });
  target.dispatchEvent(event);
}

beforeEach(() => {
  frames = new Map(); frameId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.set(++frameId, callback); return frameId; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: vi.fn(), configurable: true });
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
});

afterEach(() => {
  for (const panel of panels.splice(0)) panel.destroy();
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("class");
  document.documentElement.removeAttribute("data-theme");
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("tree panel", () => {
  it("mounts one closed Shadow DOM host without stealing page focus", () => {
    const pageInput = document.createElement("input"); document.body.append(pageInput); pageInput.focus();
    const { panel } = setup();
    const again = mountTreePanel({ ...setupOptions(), document });
    expect(again).toBe(panel);
    expect(document.querySelectorAll("#repotreex-root")).toHaveLength(1);
    expect(panel.host.shadowRoot).toBeNull();
    expect(panel.root.mode).toBe("closed");
    expect(document.activeElement).toBe(pageInput);
    expect(panel.root.querySelector("style")?.textContent).toContain(":host");
  });

  it("renders selected and expanded tree semantics and opens a file with Enter", () => {
    const { panel, options } = setup(); panel.render(state()); flush();
    const file = row(panel, "src/app.ts");
    expect(file.getAttribute("aria-selected")).toBe("true");
    expect(file.getAttribute("aria-level")).toBe("2");
    expect(file.getAttribute("aria-posinset")).toBe("1");
    expect(file.getAttribute("aria-setsize")).toBe("2");
    expect(file.tabIndex).toBe(0);
    expect(row(panel, "src").getAttribute("aria-expanded")).toBe("true");
    expect(file.hasAttribute("aria-expanded")).toBe(false);
    key(file, "Enter"); expect(options.onOpenFile).toHaveBeenCalledExactlyOnceWith("src/app.ts");
  });

  it("uses only visible nodes and coalesces renders into one latest-state frame", () => {
    const { panel } = setup();
    panel.render(state()); panel.render(state({ snapshot: { ...state().snapshot, visibleNodes: [node("README.md")] } }));
    expect(frames.size).toBe(1); expect(panel.root.querySelectorAll('[role="treeitem"]')).toHaveLength(0);
    flush(); expect(panel.root.querySelectorAll('[role="treeitem"]')).toHaveLength(1);
    expect(row(panel, "README.md").textContent).toContain("README.md");
  });

  it("toggles folders through delegated nested-icon clicks, Enter and Space", () => {
    const { panel, options } = setup(); panel.render(state()); flush();
    row(panel, "src").querySelector("path")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    key(row(panel, "src"), "Enter"); key(row(panel, "src"), " ");
    expect(options.onToggleDirectory).toHaveBeenCalledTimes(3);
    expect(options.onToggleDirectory).toHaveBeenLastCalledWith("src");
    expect(options.onOpenFile).not.toHaveBeenCalled();
  });

  it("navigates visible rows with arrows and Home/End using one roving tab stop", () => {
    const { panel } = setup(); panel.render(state()); flush(); panel.focusPath("src/app.ts");
    key(row(panel, "src/app.ts"), "ArrowDown"); expect(panel.root.activeElement).toBe(row(panel, "src/other.ts"));
    key(row(panel, "src/other.ts"), "ArrowUp"); expect(panel.root.activeElement).toBe(row(panel, "src/app.ts"));
    key(row(panel, "src/app.ts"), "Home"); expect(panel.root.activeElement).toBe(row(panel, "src"));
    key(row(panel, "src"), "ArrowUp"); expect(panel.root.activeElement).toBe(row(panel, "src"));
    key(row(panel, "src"), "End"); expect(panel.root.activeElement).toBe(row(panel, "vendor"));
    key(row(panel, "vendor"), "ArrowDown"); expect(panel.root.activeElement).toBe(row(panel, "vendor"));
    expect(panel.root.querySelectorAll('[role="treeitem"][tabindex="0"]')).toHaveLength(1);
  });

  it("expands with Right, focuses the first child, and collapses or focuses a parent with Left", () => {
    const { panel, options } = setup(); panel.render(state()); flush();
    key(row(panel, "src"), "ArrowRight"); expect(panel.root.activeElement).toBe(row(panel, "src/app.ts"));
    key(row(panel, "src/app.ts"), "ArrowLeft"); expect(panel.root.activeElement).toBe(row(panel, "src"));
    key(row(panel, "src"), "ArrowLeft"); expect(options.onToggleDirectory).toHaveBeenCalledExactlyOnceWith("src");
    panel.render(state({ snapshot: { ...state().snapshot, visibleNodes: [node("src", "directory")] } })); flush();
    key(row(panel, "src"), "ArrowRight"); expect(options.onToggleDirectory).toHaveBeenCalledTimes(2);
  });

  it("retains focus across render and falls back to a visible ancestor without stealing search focus", () => {
    const { panel } = setup(); panel.render(state()); flush(); panel.focusPath("src/other.ts");
    panel.render(state()); flush(); expect(panel.root.activeElement).toBe(row(panel, "src/other.ts"));
    panel.render(state({ snapshot: { ...state().snapshot, visibleNodes: [node("src", "directory")] } })); flush();
    expect(panel.root.activeElement).toBe(row(panel, "src"));
    control<HTMLInputElement>(panel, "Search repository paths").focus(); panel.render(state()); flush();
    expect(panel.root.activeElement).toBe(control(panel, "Search repository paths"));
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "auto" });
  });

  it("searches cached hidden nodes, reports query changes, and resets no-match results", () => {
    const { panel, options } = setup();
    const snapshot: TreeSnapshot = { ...state().snapshot, visibleNodes: [node("src", "directory")] };
    panel.render(state({ snapshot })); flush();
    const input = control<HTMLInputElement>(panel, "Search repository paths"); input.value = "app";
    input.dispatchEvent(new Event("input", { bubbles: true })); flush();
    expect(options.onSearch).toHaveBeenCalledExactlyOnceWith("app");
    expect(row(panel, "src/app.ts").getAttribute("aria-level")).toBe("1");
    expect(row(panel, "src/app.ts").textContent).toContain("src/app.ts");
    input.value = "absent"; input.dispatchEvent(new Event("input", { bubbles: true })); flush();
    expect(panel.root.querySelectorAll('[role="treeitem"]')).toHaveLength(0);
    expect(panel.root.textContent).toContain("No matching paths");
    key(input, "Escape"); flush(); expect(input.value).toBe(""); expect(options.onSearch).toHaveBeenLastCalledWith("");
    expect(row(panel, "src")).toBeDefined();
  });

  it("keeps refs and repository names literal and invokes ref/refresh/full-tree actions", () => {
    const { panel, options } = setup();
    panel.render(state({ snapshot: { ...state().snapshot, repo: 'synthetic/<img src=x onerror="bad">' } })); flush();
    expect(panel.root.querySelector("img")).toBeNull(); expect(panel.root.textContent).toContain('<img src=x onerror="bad">');
    const select = control<HTMLSelectElement>(panel, "Repository ref"); select.value = "v1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    control(panel, "Refresh repository tree").click(); control(panel, "Load full tree for search").click();
    expect(options.onSelectRef).toHaveBeenCalledExactlyOnceWith("v1");
    expect(options.onRefresh).toHaveBeenCalledOnce(); expect(options.onLoadFullTree).toHaveBeenCalledOnce();
    expect(select.querySelectorAll("optgroup")).toHaveLength(2);
  });

  it("reports full-tree progress, cancellation and truncation accessibly", () => {
    const { panel, options } = setup();
    panel.render(state({ fullTree: { loading: true, progress: { loadedNodes: 25, queuedDirectories: 3, activeRequests: 2 } } })); flush();
    expect(panel.root.querySelector('[role="tree"]')?.getAttribute("aria-busy")).toBe("true");
    expect(panel.root.querySelector('[role="status"]')?.textContent).toContain("25 paths");
    control(panel, "Cancel full-tree search").click(); expect(options.onCancelFullTree).toHaveBeenCalledOnce();
    panel.render(state({ fullTree: { loading: false, result: { loadedNodes: 10_000, truncated: true, cancelled: false } } })); flush();
    expect(panel.root.textContent).toContain("Search is incomplete");
  });

  it("limits cached search results and makes overflow explicit", () => {
    const { panel } = setup(); const snapshot = state().snapshot;
    panel.render(state({ query: "file", snapshot: { ...snapshot, nodesByPath: Object.fromEntries(Array.from({ length: 205 }, (_, i) => {
      const entry = node(`file${i}.ts`); return [entry.path, entry];
    })) } })); flush();
    expect(panel.root.querySelectorAll('[role="treeitem"]')).toHaveLength(200);
    expect(panel.root.textContent).toContain("More matches");
  });

  it("collapses and reopens with focus transfer and only an open-state preference", () => {
    const { panel, options } = setup(); panel.render(state()); flush();
    control(panel, "Collapse repository tree").focus(); control(panel, "Collapse repository tree").click();
    expect(panel.root.querySelector<HTMLElement>('[role="region"]')?.hidden).toBe(true);
    expect(document.documentElement.classList.contains("repotreex-panel-open")).toBe(false);
    expect(panel.root.activeElement).toBe(control(panel, "Open repository tree"));
    expect(options.onPreferenceChange).toHaveBeenCalledExactlyOnceWith({ panelOpen: false });
    control(panel, "Open repository tree").click();
    expect(panel.root.querySelector<HTMLElement>('[role="region"]')?.hidden).toBe(false);
    expect(panel.root.activeElement).toBe(row(panel, "src/app.ts"));
    expect(options.onPreferenceChange).toHaveBeenLastCalledWith({ panelOpen: true });
  });

  it("restores saved open/width preferences without writing on mount or render", () => {
    const { panel, options } = setup({ preferences: { panelOpen: false, panelWidth: 420 } });
    panel.render(state()); flush();
    expect(control(panel, "Open repository tree").hidden).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--repotreex-panel-width")).toBe("420px");
    expect(options.onPreferenceChange).not.toHaveBeenCalled();
  });

  it("clamps pointer resize, captures the pointer and saves only the final width", () => {
    const { panel, options } = setup(); const handle = control(panel, "Resize repository tree");
    handle.setPointerCapture = vi.fn(); handle.releasePointerCapture = vi.fn();
    pointer(handle, "pointerdown", 300); pointer(handle, "pointermove", 900);
    expect(handle.setPointerCapture).toHaveBeenCalledWith(7);
    expect(handle.getAttribute("aria-valuenow")).toBe("560"); expect(options.onPreferenceChange).not.toHaveBeenCalled();
    pointer(handle, "pointerup", 900); expect(options.onPreferenceChange).toHaveBeenCalledExactlyOnceWith({ panelWidth: 560 });
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(7);
    pointer(handle, "pointerdown", 560); pointer(handle, "pointermove", 0); pointer(handle, "pointerup", 0);
    expect(options.onPreferenceChange).toHaveBeenLastCalledWith({ panelWidth: 240 });
  });

  it("cancels interrupted resizing and provides keyboard resizing", () => {
    const { panel, options } = setup(); const handle = control(panel, "Resize repository tree");
    handle.setPointerCapture = vi.fn(); handle.releasePointerCapture = vi.fn();
    pointer(handle, "pointerdown", 300); pointer(handle, "pointermove", 450); pointer(handle, "pointercancel", 450);
    expect(handle.getAttribute("aria-valuenow")).toBe("300"); expect(options.onPreferenceChange).not.toHaveBeenCalled();
    key(handle, "End"); expect(options.onPreferenceChange).toHaveBeenCalledExactlyOnceWith({ panelWidth: 560 });
    key(handle, "Home"); expect(options.onPreferenceChange).toHaveBeenLastCalledWith({ panelWidth: 240 });
    key(handle, "ArrowRight"); expect(options.onPreferenceChange).toHaveBeenLastCalledWith({ panelWidth: 256 });
  });

  it("uses a mobile overlay/backdrop rather than changing CNB padding", () => {
    Object.defineProperty(window, "innerWidth", { value: 799, configurable: true });
    const { panel, options } = setup(); panel.render(state()); flush();
    expect(panel.host.dataset.overlay).toBe("true"); expect(document.documentElement.classList.contains("repotreex-panel-open")).toBe(false);
    expect(control(panel, "Close repository tree overlay").hidden).toBe(false);
    control(panel, "Close repository tree overlay").click(); expect(options.onPreferenceChange).toHaveBeenCalledWith({ panelOpen: false });
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true }); window.dispatchEvent(new Event("resize"));
    control(panel, "Open repository tree").click();
    expect(panel.host.dataset.overlay).toBe("false"); expect(document.documentElement.classList.contains("repotreex-panel-open")).toBe(true);
  });

  it("detects fixed top chrome and tracks CNB dark/light appearance", async () => {
    const header = document.createElement("header"); header.style.position = "fixed";
    vi.spyOn(header, "getBoundingClientRect").mockReturnValue({ ...new DOMRect(), top: 0, bottom: 64, height: 64 });
    document.body.append(header); document.documentElement.dataset.theme = "dark";
    const { panel } = setup();
    expect(panel.host.style.getPropertyValue("--repotreex-top-offset")).toBe("64px");
    expect(panel.host.dataset.theme).toBe("dark");
    document.documentElement.dataset.theme = "light"; await Promise.resolve();
    expect(panel.host.dataset.theme).toBe("light");
  });

  it("shows empty, loading and sanitized root/directory errors with explicit retry actions", () => {
    const { panel, options } = setup(); const snapshot = state().snapshot;
    panel.render(state({ snapshot: { ...snapshot, visibleNodes: [], nodesByPath: { "": node("", "directory", { depth: 0 }) } } })); flush();
    expect(panel.root.textContent).toContain("This repository is empty");
    panel.render(state({ loading: true })); flush();
    expect(panel.root.querySelector('[role="tree"]')?.getAttribute("aria-busy")).toBe("true");
    panel.render(state({ error: { code: "network" } })); flush();
    expect(panel.root.querySelector('[role="alert"]')?.textContent).toContain("Network");
    control(panel, "Retry repository tree").click(); expect(options.onRefresh).toHaveBeenCalledOnce();
    panel.render(state({ snapshot: { ...snapshot, visibleNodes: [node("src", "directory", { error: { code: "not-found" }, loading: true })] } })); flush();
    expect(row(panel, "src").getAttribute("aria-busy")).toBe("true");
    control(panel, "Retry directory").click(); expect(options.onRetryDirectory).toHaveBeenCalledExactlyOnceWith("src");
    expect(options.onToggleDirectory).not.toHaveBeenCalled();
  });

  it.each(["signed-out", "forbidden"] as const)("clears sensitive DOM synchronously on %s even when given stale metadata", (code) => {
    const { panel, options } = setup(); panel.render(state({ query: "app" })); flush();
    const oldRow = row(panel, "src/app.ts");
    panel.render(state({ error: { code } }));
    expect(panel.root.textContent).not.toContain("demo"); expect(panel.root.textContent).not.toContain("src/app.ts");
    expect(control<HTMLInputElement>(panel, "Search repository paths").value).toBe("");
    expect(control<HTMLSelectElement>(panel, "Repository ref").options).toHaveLength(0);
    expect(oldRow.textContent).toBe(""); expect(oldRow.hasAttribute("data-path")).toBe(false);
    oldRow.click(); expect(options.onOpenFile).not.toHaveBeenCalled(); flush();
    expect(panel.root.textContent).not.toContain("demo");
  });

  it("clears pending frames and DOM on session replacement or explicit lifecycle clearing", () => {
    const { panel } = setup(); panel.render(state({ query: "app" })); flush();
    panel.render(state());
    panel.render(state({ snapshot: { ...state().snapshot, repo: "synthetic/new", ref: "v2", visibleNodes: [] }, refs: [] }));
    expect(panel.root.textContent).not.toContain("demo"); expect(panel.root.textContent).not.toContain("src/app.ts");
    panel.clearSensitiveData(); expect(frames.size).toBe(0); flush();
    expect(panel.root.textContent).not.toContain("new"); expect(panel.root.querySelectorAll('[data-path]')).toHaveLength(0);
    panel.render(state({ snapshot: { repo: null, ref: null, nodesByPath: {}, visibleNodes: [], expandedPaths: [], selectedPath: null } }));
    flush(); expect(control<HTMLSelectElement>(panel, "Repository ref").options).toHaveLength(0);
  });

  it("persists only panel open/width through the real PreferenceStore callback", async () => {
    const writes: Record<string, unknown>[] = [];
    const store = createPreferenceStore({ get: async () => ({}), set: async (items) => { writes.push(items); } });
    const saves: Promise<unknown>[] = [];
    const { panel } = setup({ onPreferenceChange: (patch) => { saves.push(store.save(patch)); } });
    panel.render(state({ query: "sensitive-search" })); flush();
    control(panel, "Collapse repository tree").click(); control(panel, "Open repository tree").click();
    key(control(panel, "Resize repository tree"), "End"); await Promise.all(saves);
    expect(writes).toEqual([
      { "repotreex.preferences": { panelOpen: false, panelWidth: 300 } },
      { "repotreex.preferences": { panelOpen: true, panelWidth: 300 } },
      { "repotreex.preferences": { panelOpen: true, panelWidth: 560 } },
    ]);
  });

  it("destroys idempotently, scrubs retained DOM and restores prior layout values and priorities exactly", () => {
    const html = document.documentElement;
    html.style.setProperty("padding-left", "18px", "important");
    html.style.setProperty("--repotreex-panel-width", "91px", "important");
    html.style.setProperty("--repotreex-page-padding-left", "7px", "important");
    html.className = "existing"; const original = html.getAttribute("style");
    const { panel, options } = setup(); panel.render(state({ query: "app" })); flush();
    const retainedRow = row(panel, "src/app.ts"); const retainedInput = control<HTMLInputElement>(panel, "Search repository paths");
    panel.render(state()); panel.destroy(); panel.destroy(); flush();
    expect(panel.host.isConnected).toBe(false); expect(panel.root.childNodes).toHaveLength(0);
    expect(retainedRow.textContent).toBe(""); expect(retainedRow.hasAttribute("data-path")).toBe(false); expect(retainedInput.value).toBe("");
    expect(html.getAttribute("style")).toBe(original); expect(html.className).toBe("existing");
    expect(document.querySelector('[data-repotreex-layout]')).toBeNull();
    panel.render(state()); panel.focusPath("src/app.ts"); retainedRow.click(); window.dispatchEvent(new Event("resize"));
    expect(frames.size).toBe(0); expect(options.onOpenFile).not.toHaveBeenCalled(); expect(options.onPreferenceChange).not.toHaveBeenCalled();
    expect(setup().panel.host.isConnected).toBe(true);
  });

  it("restores absent layout custom properties after destroy", () => {
    const { panel } = setup(); panel.destroy();
    expect(document.documentElement.style.getPropertyValue("--repotreex-panel-width")).toBe("");
    expect(document.documentElement.style.getPropertyValue("padding-left")).toBe("");
  });

  it.each(["root", "full-tree"] as const)("clears stale metadata when an authorization failure comes from %s", (source) => {
    const { panel } = setup(); panel.render(state()); flush();
    const original = state();
    panel.render(source === "root"
      ? state({ snapshot: { ...original.snapshot, nodesByPath: { ...original.snapshot.nodesByPath, "": node("", "directory", { error: { code: "forbidden" } }) } } })
      : state({ fullTree: { loading: false, error: { code: "signed-out" } } }));
    expect(panel.root.querySelectorAll('[data-path]')).toHaveLength(0);
    expect(panel.root.textContent).not.toContain("demo");
    flush(); expect(panel.root.textContent).not.toContain("demo");
  });

  it("retains requested pre-render focus and falls back to the empty tree when no rows remain", () => {
    const { panel } = setup(); panel.render(state()); panel.focusPath("README.md"); flush();
    expect(panel.root.activeElement).toBe(row(panel, "README.md"));
    panel.render(state({ snapshot: { ...state().snapshot, visibleNodes: [] } })); flush();
    expect(panel.root.activeElement).toBe(panel.root.querySelector('[role="tree"]'));
  });

  it("never lets a stale same-session state restore a cleared search query", () => {
    const { panel, options } = setup(); panel.render(state({ query: "app" })); flush();
    const input = control<HTMLInputElement>(panel, "Search repository paths");
    input.value = "other"; input.dispatchEvent(new Event("input", { bubbles: true }));
    panel.render(state()); flush();
    expect(input.value).toBe("other"); expect(row(panel, "src/other.ts")).toBeDefined();
    expect(options.onSearch).toHaveBeenCalledExactlyOnceWith("other");
  });

  it("keeps selection roving on file navigation unless a tree row is actively focused", () => {
    const { panel } = setup(); panel.render(state()); flush();
    control(panel, "Search repository paths").focus();
    panel.render(state({ snapshot: { ...state().snapshot, selectedPath: "README.md" } })); flush();
    expect(row(panel, "README.md").tabIndex).toBe(0);
    expect(panel.root.activeElement).toBe(control(panel, "Search repository paths"));
  });

  it("ignores non-primary pointers and rolls back a lost capture without persistence", () => {
    const { panel, options } = setup(); const handle = control(panel, "Resize repository tree");
    handle.setPointerCapture = vi.fn(); handle.releasePointerCapture = vi.fn();
    const secondary = new MouseEvent("pointerdown", { button: 2, bubbles: true });
    handle.dispatchEvent(secondary); expect(handle.setPointerCapture).not.toHaveBeenCalled();
    pointer(handle, "pointerdown", 300); pointer(handle, "pointermove", 400); pointer(handle, "lostpointercapture", 400);
    expect(handle.getAttribute("aria-valuenow")).toBe("300"); expect(options.onPreferenceChange).not.toHaveBeenCalled();
  });

  it("restores pre-existing layout class ownership and preserves concurrent unrelated page edits", () => {
    document.documentElement.classList.add("repotreex-panel-open");
    const { panel } = setup();
    document.documentElement.style.setProperty("color", "red"); document.documentElement.classList.add("new-page-class");
    panel.destroy(); expect(document.documentElement.classList.contains("repotreex-panel-open")).toBe(true);
    expect(document.documentElement.classList.contains("new-page-class")).toBe(true);
    expect(document.documentElement.style.color).toBe("red");
  });

  it("scrubs retained text nodes, including ref names, on lifecycle clearing", () => {
    const { panel } = setup(); panel.render(state()); flush();
    const retainedText = row(panel, "src/app.ts").querySelector(".label")?.firstChild;
    const retainedRef = control<HTMLSelectElement>(panel, "Repository ref").options[0].firstChild;
    panel.clearSensitiveData();
    expect(retainedText?.nodeValue).toBe(""); expect(retainedRef?.nodeValue).toBe("");
  });

  it("preserves page keyboard shortcuts by stopping panel actions from crossing the shadow boundary", () => {
    const { panel } = setup(); panel.render(state()); flush();
    const click = vi.fn(); const input = vi.fn(); const keydown = vi.fn();
    document.addEventListener("click", click, { once: true });
    document.addEventListener("input", input, { once: true });
    document.addEventListener("keydown", keydown, { once: true });
    control(panel, "Refresh repository tree").dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    control(panel, "Search repository paths").dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    control(panel, "Resize repository tree").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, composed: true }));
    document.removeEventListener("click", click); document.removeEventListener("input", input); document.removeEventListener("keydown", keydown);
    expect(click).not.toHaveBeenCalled(); expect(input).not.toHaveBeenCalled(); expect(keydown).not.toHaveBeenCalled();
  });

  it("restores the original page focus on teardown without stealing later external focus", () => {
    const input = document.createElement("input"); document.body.append(input); input.focus();
    const { panel } = setup(); panel.render(state()); flush(); panel.focusPath("src/app.ts");
    panel.destroy(); expect(document.activeElement).toBe(input);
  });

  it("reopens a cleared panel into a focusable empty tree rather than a disabled search control", () => {
    const { panel } = setup(); panel.render(state()); flush();
    control(panel, "Collapse repository tree").click(); panel.clearSensitiveData(); control(panel, "Open repository tree").click();
    expect(panel.root.activeElement).toBe(panel.root.querySelector('[role="tree"]'));
  });

  it("honors explicit focusPath when called during an update to an already focused row", () => {
    const { panel } = setup(); panel.render(state()); flush(); panel.focusPath("src/app.ts");
    panel.render(state()); panel.focusPath("README.md"); flush();
    expect(panel.root.activeElement).toBe(row(panel, "README.md"));
  });

  it("synchronously clears focused rows into the empty tree without trapping focus on a detached item", () => {
    const { panel } = setup(); panel.render(state()); flush(); panel.focusPath("src/app.ts");
    panel.clearSensitiveData(); expect(panel.root.activeElement).toBe(panel.root.querySelector('[role="tree"]'));
  });

  it("does not mislabel failed or not-yet-loaded roots as empty repositories", () => {
    const { panel } = setup();
    panel.render(state({ snapshot: { ...state().snapshot, visibleNodes: [], nodesByPath: { "": node("", "directory", { loaded: false }) } } })); flush();
    expect(panel.root.textContent).not.toContain("This repository is empty");
    panel.render(state({ error: { code: "network" }, snapshot: { ...state().snapshot, visibleNodes: [] } })); flush();
    expect(panel.root.textContent).not.toContain("This repository is empty");
  });

  it("distinguishes cancellation from errors and keeps full-tree retries separate from root refresh", () => {
    const { panel, options } = setup(); panel.render(state({ fullTree: { loading: false, error: { code: "network" } } })); flush();
    control(panel, "Retry full-tree search").click(); expect(options.onLoadFullTree).toHaveBeenCalledOnce();
    expect(options.onRefresh).not.toHaveBeenCalled();
    panel.render(state({ error: { code: "cancelled" } })); flush();
    expect(panel.root.querySelector<HTMLElement>('[role="alert"]')?.hidden).toBe(true);
  });

  it("announces root errors from a cleared store without trusting stale metadata", () => {
    const { panel } = setup(); panel.render(state()); flush();
    panel.render(state({ snapshot: { repo: null, ref: null, nodesByPath: {}, visibleNodes: [], expandedPaths: [], selectedPath: null }, error: { code: "network" } })); flush();
    expect(panel.root.querySelector('[role="alert"]')?.textContent).toContain("Network");
    expect(panel.root.textContent).not.toContain("demo");
  });

  it("retains ref control focus across asynchronous tree updates", () => {
    const { panel } = setup(); panel.render(state()); flush(); control(panel, "Repository ref").focus();
    panel.render(state()); flush(); expect(panel.root.activeElement).toBe(control(panel, "Repository ref"));
  });

  it("does not steal a user's new external focus when destroyed", () => {
    const pageInput = document.createElement("input"); document.body.append(pageInput);
    const { panel } = setup(); panel.render(state()); flush(); panel.focusPath("src/app.ts"); pageInput.focus(); panel.destroy();
    expect(document.activeElement).toBe(pageInput);
  });

  it("shows loading only for real pending loads and exposes the current ref before enumeration", () => {
    const { panel } = setup(); panel.render(state({ refs: [] })); flush();
    expect(control<HTMLSelectElement>(panel, "Repository ref").value).toBe("main");
    expect(panel.root.querySelector('[role="tree"]')?.getAttribute("aria-busy")).toBe("false");
  });

  it("restores finite initial width bounds and never persists invalid width input", () => {
    const cases: [number, string][] = [[10, "240"], [900, "560"], [NaN, "300"]];
    for (const [input, expected] of cases) {
      const { panel, options } = setup({ preferences: { panelOpen: true, panelWidth: input } });
      expect(control(panel, "Resize repository tree").getAttribute("aria-valuenow")).toBe(expected);
      expect(options.onPreferenceChange).not.toHaveBeenCalled(); panel.destroy();
    }
  });

  it.each(["clear", "destroy"] as const)("scrubs outgoing repository text before ordinary rerender and later %s", (lifecycle) => {
    const { panel } = setup(); panel.render(state()); flush();
    const repository = panel.root.querySelector(".repository");
    if (!repository?.firstChild) throw new Error("Expected synthetic repository text");
    const oldText = repository.firstChild;
    panel.render(state()); flush();
    expect(oldText.nodeValue).toBe("");
    expect(repository.textContent).toBe("demo");
    const latestText = repository.firstChild;
    if (lifecycle === "clear") panel.clearSensitiveData();
    else panel.destroy();
    expect(latestText?.nodeValue).toBe("");
    expect(oldText.nodeValue).toBe("");
  });

  it("keeps focused-row scrolling ahead of a distant selected row during rerender", () => {
    const { panel } = setup(); panel.render(state()); flush(); panel.focusPath("vendor");
    const scrolled: HTMLElement[] = [];
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) { scrolled.push(this); });
    panel.render(state()); flush();
    expect(panel.root.activeElement).toBe(row(panel, "vendor"));
    expect(scrolled.map((item) => item.dataset.path)).toEqual(["vendor"]);
  });

  it("transfers focus from an empty tree to the selected row when results arrive", () => {
    const { panel } = setup();
    panel.render(state({ snapshot: { ...state().snapshot, visibleNodes: [] } })); flush();
    control(panel, "Repository files").focus();
    panel.render(state()); flush();
    expect(panel.root.activeElement).toBe(row(panel, "src/app.ts"));
    expect(row(panel, "src/app.ts").tabIndex).toBe(0);
  });

  it.each(["root", "full-tree", "directory"] as const)("preserves replaced %s retry focus, then falls back to a valid tree stop", (source) => {
    const { panel } = setup();
    const failure = source === "root" ? state({ error: { code: "network" } })
      : source === "full-tree" ? state({ fullTree: { loading: false, error: { code: "network" } } })
      : state({ snapshot: { ...state().snapshot, visibleNodes: [node("src", "directory", { error: { code: "network" } })] } });
    const label = source === "root" ? "Retry repository tree" : source === "full-tree" ? "Retry full-tree search" : "Retry directory";
    panel.render(failure); flush();
    const oldRetry = control(panel, label); oldRetry.focus();
    panel.render(failure); flush();
    expect(panel.root.activeElement).toBe(control(panel, label));
    expect(oldRetry.isConnected).toBe(false);
    panel.render(state()); flush();
    expect(panel.root.activeElement).toBe(row(panel, source === "directory" ? "src" : "src/app.ts"));
    expect((panel.root.activeElement as HTMLElement).tabIndex).toBe(0);
  });

  it("falls back to a focusable empty tree after a retry disappears without rows", () => {
    const { panel } = setup();
    const snapshot = { ...state().snapshot, visibleNodes: [] };
    panel.render(state({ snapshot, error: { code: "network" } })); flush();
    control(panel, "Retry repository tree").focus();
    panel.render(state({ snapshot })); flush();
    const tree = control(panel, "Repository files");
    expect(panel.root.activeElement).toBe(tree); expect(tree.tabIndex).toBe(0);
  });

  it("honors deferred explicit focus instead of restoring a replaced retry", () => {
    const { panel } = setup(); panel.render(state({ error: { code: "network" } })); flush();
    control(panel, "Retry repository tree").focus();
    panel.render(state({ error: { code: "network" } })); panel.focusPath("vendor"); flush();
    expect(panel.root.activeElement).toBe(row(panel, "vendor"));
  });

  it("matches replaced directory retries by literal path without stealing external focus", () => {
    const { panel } = setup();
    const path = 'docs/["synthetic"]';
    const failure = state({ snapshot: { ...state().snapshot, visibleNodes: [
      node("src", "directory", { error: { code: "network" } }),
      node(path, "directory", { error: { code: "network" } }),
    ] } });
    panel.render(failure); flush();
    const retries = [...panel.root.querySelectorAll<HTMLButtonElement>('[data-action="retry-directory"]')];
    const retry = retries.find((item) => item.dataset.path === path);
    if (!retry) throw new Error("Expected synthetic retry");
    retry.focus(); panel.render(failure); flush();
    expect((panel.root.activeElement as HTMLElement).dataset.path).toBe(path);
    const pageInput = document.createElement("input"); document.body.append(pageInput); pageInput.focus();
    panel.render(state()); flush(); expect(document.activeElement).toBe(pageInput);
  });

  it("scrubs outgoing rows, ref options and error text on ordinary rerender", () => {
    const { panel } = setup(); panel.render(state({ error: { code: "network" } })); flush();
    const oldRow = row(panel, "src/app.ts");
    const oldLabel = oldRow.querySelector(".label")?.firstChild;
    const oldRef = control<HTMLSelectElement>(panel, "Repository ref").options[0];
    const oldRefText = oldRef.firstChild;
    const oldRetry = control(panel, "Retry repository tree");
    const oldRetryText = oldRetry.firstChild;
    panel.render(state()); flush();
    expect(oldRow.textContent).toBe(""); expect(oldRow.hasAttribute("data-path")).toBe(false);
    expect(oldLabel?.nodeValue).toBe(""); expect(oldRef.value).toBe(""); expect(oldRefText?.nodeValue).toBe("");
    expect(oldRetry.textContent).toBe(""); expect(oldRetryText?.nodeValue).toBe("");
  });

  it("does not transfer focus when an unfocused empty tree gains rows", () => {
    const { panel } = setup();
    panel.render(state({ snapshot: { ...state().snapshot, visibleNodes: [] } })); flush();
    const input = control<HTMLInputElement>(panel, "Search repository paths"); input.focus();
    panel.render(state()); flush(); expect(panel.root.activeElement).toBe(input);
  });

  it("represents search results as flat leaf items without hierarchical expansion", () => {
    const { panel } = setup(); panel.render(state({ query: "src" })); flush();
    const directory = row(panel, "src");
    expect(directory.getAttribute("aria-level")).toBe("1");
    expect(directory.hasAttribute("aria-expanded")).toBe(false);
    expect(directory.querySelector(".chevron")).toBeNull();
    expect(row(panel, "src/app.ts").getAttribute("aria-setsize")).toBe("3");
  });

  it("ignores hierarchical Left/Right keys in flat search but retains directory activation", () => {
    const { panel, options } = setup(); panel.render(state({ query: "src" })); flush(); panel.focusPath("src");
    key(row(panel, "src"), "ArrowRight"); expect(panel.root.activeElement).toBe(row(panel, "src"));
    key(row(panel, "src"), "ArrowLeft"); expect(options.onToggleDirectory).not.toHaveBeenCalled();
    panel.focusPath("src/app.ts"); key(row(panel, "src/app.ts"), "ArrowLeft");
    expect(panel.root.activeElement).toBe(row(panel, "src/app.ts"));
    key(row(panel, "src"), "Enter"); expect(options.onToggleDirectory).toHaveBeenCalledExactlyOnceWith("src");
    panel.render(state({ query: "" })); flush(); panel.focusPath("src");
    key(row(panel, "src"), "ArrowRight"); expect(panel.root.activeElement).toBe(row(panel, "src/app.ts"));
  });

  it("contains owned keyup without repeating keydown actions or suppressing external page keys", () => {
    const { panel, options } = setup(); panel.render(state()); flush();
    const received: string[] = [];
    const onPageKey = (event: KeyboardEvent) => { received.push(event.key); };
    document.addEventListener("keyup", onPageKey);
    try {
      for (const target of [row(panel, "src/app.ts"), control(panel, "Search repository paths"), control(panel, "Resize repository tree")]) {
        target.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true, composed: true }));
      }
      expect(received).toEqual([]); expect(options.onOpenFile).not.toHaveBeenCalled();
      const input = document.createElement("input"); document.body.append(input);
      input.dispatchEvent(new KeyboardEvent("keyup", { key: "s", bubbles: true, composed: true }));
      expect(received).toEqual(["s"]);
    } finally { document.removeEventListener("keyup", onPageKey); }
  });

  it("updates full-search tooltip along with its load/cancel label", () => {
    const { panel } = setup(); panel.render(state()); flush();
    expect(control(panel, "Load full tree for search").title).toBe("Load full tree for search");
    panel.render(state({ fullTree: { loading: true } })); flush();
    expect(control(panel, "Cancel full-tree search").title).toBe("Cancel full-tree search");
    panel.render(state()); flush();
    expect(control(panel, "Load full tree for search").title).toBe("Load full tree for search");
  });
});

function setupOptions(): Omit<PanelOptions, "document"> {
  return {
    onOpenFile: vi.fn(), onToggleDirectory: vi.fn(), onRefresh: vi.fn(), onSearch: vi.fn(),
    onLoadFullTree: vi.fn(), onSelectRef: vi.fn(), onPreferenceChange: vi.fn(),
  };
}
