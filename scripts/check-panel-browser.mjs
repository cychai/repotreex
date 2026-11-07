import assert from "node:assert/strict";
import { build } from "esbuild";

/* global document, requestAnimationFrame, getComputedStyle -- Executed only in page.evaluate callbacks. */
// Use an installed Playwright and Chromium; this probe never installs or serves anything.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
const compiled = await build({
  entryPoints: ["src/content/panel.ts"], bundle: true, write: false,
  format: "iife", globalName: "RepoTreeXPanel", platform: "browser",
  target: "chrome120", loader: { ".css": "text" },
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
});
const failures = [];
const settle = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function check(name, run, hostileGeometry = true) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  const errors = []; const requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (["error", "warning"].includes(message.type())) errors.push(message.text()); });
  page.on("request", () => requests.push("unexpected request"));
  try {
    await page.setContent(`<!doctype html><html style="padding-left:18px !important"><head><title>Synthetic panel regression</title>
      <style>body{margin:0;padding:88px 24px;font:16px monospace}header{position:fixed;inset:0 0 auto;height:64px}
      ${hostileGeometry ? "div{position:static;width:100%;margin:19px;padding:27px;transform:translateX(30px);display:flex;border:8px solid red}" : ""}
      li,button,input{color:red !important;font-size:60px !important}</style></head>
      <body><header>Independent page chrome</header><main>Unmodified synthetic page<input aria-label="Page input"></main></body></html>`);
    await page.addScriptTag({ content: compiled.outputFiles[0].text });
    await page.evaluate(() => {
      const entry = (path, kind = "file", patch = {}) => ({
        path, kind, name: path.split("/").at(-1), sha: "synthetic-sha",
        parentPath: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "", depth: path.split("/").length,
        childPaths: [], loaded: true, loading: false, expanded: false, selected: false, error: null, ...patch,
      });
      const nodes = [entry("src", "directory", { expanded: true, childPaths: ["src/app.ts"] }), entry("src/app.ts"),
        ...Array.from({ length: 100 }, (_, index) => entry(`file${index}.ts`))];
      const root = entry("", "directory", { depth: 0, parentPath: null, childPaths: ["src", ...nodes.slice(2).map((item) => item.path)] });
      globalThis.fixture = { snapshot: { repo: "synthetic/team/demo", ref: "main", visibleNodes: nodes,
        nodesByPath: Object.fromEntries([root, ...nodes].map((item) => [item.path, item])), expandedPaths: ["src"], selectedPath: "src/app.ts" },
        refs: [{ kind: "branch", name: "main", sha: "synthetic-main" }] };
      globalThis.preferences = [];
      globalThis.panel = globalThis.RepoTreeXPanel.mountTreePanel({ document,
        onOpenFile() {}, onToggleDirectory() {}, onSearch() {}, onRefresh() {}, onLoadFullTree() {},
        onSelectRef() {}, onPreferenceChange(patch) { globalThis.preferences.push(patch); } });
      globalThis.panel.render(globalThis.fixture);
    });
    await settle(page);
    assert.equal(page.url(), "about:blank"); assert.equal(await page.title(), "Synthetic panel regression");
    await run(page);
    assert.deepEqual(errors, []); assert.deepEqual(requests, []);
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(new Error(name, { cause: error }));
    console.error(`FAIL ${name}: ${error.message}`);
  } finally { await page.close(); }
}

try {
  await check("host cascade isolation on desktop, collapse and mobile", async (page) => {
    assert.deepEqual(await page.evaluate(() => {
      const host = globalThis.panel.host; const bounds = host.getBoundingClientRect(); const style = getComputedStyle(host);
      return { top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height, position: style.position,
        padding: style.paddingLeft, margin: style.marginLeft, transform: style.transform, display: style.display };
    }), { top: 64, left: 0, width: 300, height: 736, position: "fixed", padding: "0px", margin: "0px", transform: "none", display: "block" });
    await page.evaluate(() => globalThis.panel.root.querySelector('[aria-label="Collapse repository tree"]').click());
    assert.equal(await page.evaluate(() => globalThis.panel.host.getBoundingClientRect().width), 32);
    await page.evaluate(() => globalThis.panel.root.querySelector('[aria-label="Open repository tree"]').click());
    await page.setViewportSize({ width: 390, height: 844 }); await settle(page);
    assert.deepEqual(await page.evaluate(() => ({ width: globalThis.panel.host.getBoundingClientRect().width,
      top: globalThis.panel.host.getBoundingClientRect().top, padding: getComputedStyle(document.documentElement).paddingLeft,
      backdrop: !globalThis.panel.root.querySelector(".backdrop").hidden })), { width: 300, top: 64, padding: "18px", backdrop: true });
    await page.mouse.click(350, 400);
    assert.equal(await page.evaluate(() => globalThis.panel.host.dataset.open), "false");
    await page.evaluate(() => globalThis.panel.root.querySelector('[aria-label="Open repository tree"]').click());
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => globalThis.panel.host.dataset.open), "false");
  });
  await check("desktop overrides inline important padding and restores it exactly", async (page) => {
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).paddingLeft), "318px");
    await page.mouse.move(301, 400); await page.mouse.down(); await page.mouse.move(451, 400); await page.mouse.up();
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).paddingLeft), "468px");
    await page.evaluate(() => globalThis.panel.root.querySelector('[aria-label="Collapse repository tree"]').click());
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).paddingLeft), "18px");
    await page.evaluate(() => globalThis.panel.root.querySelector('[aria-label="Open repository tree"]').click());
    await page.setViewportSize({ width: 390, height: 844 }); await settle(page);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).paddingLeft), "18px");
    await page.setViewportSize({ width: 1280, height: 800 }); await settle(page);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).paddingLeft), "468px");
    assert.deepEqual(await page.evaluate(() => {
      globalThis.panel.destroy();
      return { value: document.documentElement.style.getPropertyValue("padding-left"),
        priority: document.documentElement.style.getPropertyPriority("padding-left"), host: document.getElementById("repotreex-root") };
    }), { value: "18px", priority: "important", host: null });
  });
  await check("focused row stays visible ahead of distant selection", async (page) => {
    assert.equal(await page.evaluate(() => {
      const tree = globalThis.panel.root.querySelector('[role="tree"]');
      return tree.scrollHeight > tree.clientHeight;
    }), true);
    await page.evaluate(() => globalThis.panel.focusPath("file99.ts"));
    await page.evaluate(() => globalThis.panel.render(globalThis.fixture)); await settle(page);
    assert.equal(await page.evaluate(() => {
      const item = globalThis.panel.root.activeElement; const bounds = item.getBoundingClientRect();
      const viewport = globalThis.panel.root.querySelector('[role="tree"]').getBoundingClientRect();
      return item.dataset.path === "file99.ts" && bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
    }), true);
    assert.equal(await page.evaluate(() => {
      const selected = globalThis.panel.root.querySelector('[aria-selected="true"]').getBoundingClientRect();
      return selected.bottom < globalThis.panel.root.querySelector('[role="tree"]').getBoundingClientRect().top;
    }), true);
  }, false);
  await check("empty-tree/retry focus transfers and keyup stays inside panel", async (page) => {
    await page.evaluate(() => globalThis.panel.render({ ...globalThis.fixture, snapshot: { ...globalThis.fixture.snapshot, visibleNodes: [] } })); await settle(page);
    await page.evaluate(() => globalThis.panel.root.querySelector('[role="tree"]').focus());
    await page.evaluate(() => globalThis.panel.render(globalThis.fixture)); await settle(page);
    assert.equal(await page.evaluate(() => globalThis.panel.root.activeElement?.dataset.path), "src/app.ts");
    await page.evaluate(() => globalThis.panel.render({ ...globalThis.fixture, error: { code: "network" } })); await settle(page);
    await page.evaluate(() => globalThis.panel.root.querySelector('[aria-label="Retry repository tree"]').focus());
    await page.evaluate(() => globalThis.panel.render({ ...globalThis.fixture, error: { code: "network" } })); await settle(page);
    assert.equal(await page.evaluate(() => globalThis.panel.root.activeElement?.getAttribute("aria-label")), "Retry repository tree");
    await page.evaluate(() => globalThis.panel.render(globalThis.fixture)); await settle(page);
    assert.equal(await page.evaluate(() => globalThis.panel.root.activeElement?.dataset.path), "src/app.ts");
    await page.evaluate(() => { globalThis.pageKeys = []; document.addEventListener("keyup", (event) => globalThis.pageKeys.push(event.key)); });
    await page.keyboard.press("ArrowDown");
    assert.deepEqual(await page.evaluate(() => globalThis.pageKeys), []);
    await page.evaluate(() => document.querySelector('input[aria-label="Page input"]').focus());
    await page.keyboard.press("s");
    assert.deepEqual(await page.evaluate(() => globalThis.pageKeys), ["s"]);
    assert.deepEqual(await page.evaluate(() => globalThis.preferences), []);
  });
} finally { await browser.close(); }
if (failures.length) throw new AggregateError(failures, "Panel browser regressions failed");
