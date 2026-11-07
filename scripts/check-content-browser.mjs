import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/* global document, getComputedStyle, history, window -- These callbacks execute in the synthetic browser page. */
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
const content = await readFile("dist/extension/content/index.js", "utf8");
const bridge = await readFile("dist/extension/page/bridge.js", "utf8");
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
});
const errors = [];
const expectedHttpDiagnostics = [];
const apiRequests = [];
const storageWrites = [];
let mode = "normal";
let delayed;
const html = `<!doctype html><html style="padding-left:18px !important"><head><title>Synthetic CNB integration</title>
  <style>header{position:fixed;inset:0 0 auto;height:64px}body{margin:0;padding:90px 24px;font:16px monospace}</style>
  </head><body><header>Synthetic page chrome</header><main>Independent content<input aria-label="Page input"></main></body></html>`;
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (!['error', 'warning'].includes(message.type())) return;
  if (/^Failed to load resource: the server responded with a status of (401|429|503) /.test(message.text())) expectedHttpDiagnostics.push(message.text());
  else errors.push(message.text());
});
await page.route("**/*", async (route) => {
  const request = route.request(); const url = new URL(request.url());
  assert.equal(url.origin, "https://cnb.cool");
  if (request.resourceType() === "document") { await route.fulfill({ status: 200, contentType: "text/html", body: html }); return; }
  assert.equal(request.method(), "GET"); assert.match(url.pathname, /\/-\/git\//);
  apiRequests.push({ pathname: url.pathname, ref: url.searchParams.get("ref") });
  if (url.pathname.endsWith("/head")) {
    await route.fulfill({ json: { name: "main", sha: "synthetic-head" } }); return;
  }
  if (url.pathname.endsWith("/branches")) {
    await route.fulfill({ json: ["main", "dev", "release", "release/v1"].map((name) => ({ name, sha: "synthetic-ref" })) }); return;
  }
  if (url.pathname.endsWith("/tags")) { await route.fulfill({ json: [{ name: "release/v1/patch", sha: "synthetic-tag" }] }); return; }
  const path = url.pathname.split("/-/git/contents")[1]?.replace(/^\//, "");
  if (mode === "delay" && path === "docs") { delayed = route; return; }
  if (mode === "auth" && path === "docs") { await route.fulfill({ status: 401, json: {} }); return; }
  if (mode === "rate" && path === "docs") { await route.fulfill({ status: 429, json: {} }); return; }
  if (mode === "server" && path === "docs") { await route.fulfill({ status: 503, json: {} }); return; }
  const entry = (path, type = "blob") => ({ path, type, name: path.split("/").at(-1), sha: "synthetic-entry" });
  const entries = path === "" ? [entry("src", "tree"), entry("docs", "tree"), entry("a.ts"), entry("b.ts")]
    : path === "src" ? url.searchParams.get("ref") === "dev" ? [] : [entry("src/a b.ts"), entry("src/nested", "tree")]
    : path === "src/nested" ? [entry("src/nested/app.ts")] : [entry("docs/guide.md")];
  await route.fulfill({ json: { type: "tree", path, name: path.split("/").at(-1), sha: "synthetic-tree", size: 0, entries } });
});
const cdp = await page.context().newCDPSession(page);
await cdp.send("Runtime.enable");
let contextId;
const evaluate = async (expression) => {
  const result = await cdp.send("Runtime.evaluate", { contextId, expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(`Synthetic isolated-world exception: ${expression}`, { cause: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text });
  return result.result.value;
};
const wait = async (expression) => {
  for (let index = 0; index < 100; index++) {
    if (await evaluate(expression)) return;
    await page.waitForTimeout(20);
  }
  throw new Error(`Synthetic integration condition timed out: ${expression}; ${JSON.stringify({ apiRequests, errors, state: await evaluate("({roots: globalThis.syntheticRoots?.length, text: globalThis.syntheticRoots?.at(-1)?.querySelector('.error')?.textContent, channels: globalThis.syntheticChannels?.length})") })}`);
};
const root = "globalThis.syntheticRoots.at(-1)";
const install = async () => {
  const { frameTree } = await cdp.send("Page.getFrameTree");
  ({ executionContextId: contextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id, worldName: "RepoTreeX synthetic content", grantUniveralAccess: false,
  }));
  await evaluate(`globalThis.syntheticRoots = []; globalThis.syntheticStored = {};
    globalThis.syntheticWrites = []; globalThis.syntheticChannels = []; globalThis.syntheticResponses = [];
    globalThis.syntheticFailSaves = 0; globalThis.syntheticHoldSaves = false; globalThis.syntheticSaveGates = [];
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(options) { const root = attach.call(this, options); if (this.id === 'repotreex-root') syntheticRoots.push(root); return root; };
    globalThis.chrome = { runtime: { id: 'synthetic-extension' }, storage: { local: {
      async get() { return structuredClone(syntheticStored); },
      async set(items) {
        syntheticWrites.push(structuredClone(items));
        if (syntheticFailSaves > 0) { syntheticFailSaves--; throw new Error('synthetic storage unavailable'); }
        if (syntheticHoldSaves) await new Promise(resolve => syntheticSaveGates.push(resolve));
        Object.assign(syntheticStored, items);
      }
    } } };
    window.addEventListener('repotreex:request', event => syntheticChannels.push(event.detail.channel));
    window.addEventListener('repotreex:response', event => syntheticResponses.push({channel:event.detail.channel,status:event.detail.status}));
    Object.defineProperty(document, 'readyState', {value:'loading', configurable:true});`);
  await evaluate(content);
  await page.addScriptTag({ content: bridge });
  await evaluate("Object.defineProperty(document, 'readyState', {value:'complete', configurable:true}); document.dispatchEvent(new Event('DOMContentLoaded'))");
  await wait(`${root}?.querySelector('[aria-selected="true"]')?.dataset.path === 'src/nested/app.ts'`);
};
try {
  await page.goto("https://cnb.cool/acme/platform/repo/-/blob/release/v1/patch/src/nested/app.ts");
  await install();
  assert.equal(await evaluate(`${root}.querySelector('select').value`), "release/v1/patch");
  assert.equal(await evaluate("new Set(syntheticChannels).size"), 1);
  assert.equal(await evaluate("document.getElementById('repotreex-root').shadowRoot"), null);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).paddingLeft), "318px");
  assert.deepEqual(apiRequests.filter((request) => request.pathname.includes("/contents")).slice(0, 3), [
    { pathname: "/acme/platform/repo/-/git/contents", ref: "release/v1/patch" },
    { pathname: "/acme/platform/repo/-/git/contents/src", ref: "release/v1/patch" },
    { pathname: "/acme/platform/repo/-/git/contents/src/nested", ref: "release/v1/patch" },
  ]);
  const initialCalls = apiRequests.length;
  await page.evaluate(() => history.pushState({}, "", "/acme/platform/repo/-/blob/release/v1/patch/b.ts"));
  await wait(`${root}.querySelector('[aria-selected="true"]')?.dataset.path === 'b.ts'`);
  assert.equal(apiRequests.length, initialCalls);
  await evaluate(`${root}.querySelector('input').value = 'app'; ${root}.querySelector('input').dispatchEvent(new Event('input', {bubbles:true}));`);
  await wait(`${root}.querySelectorAll('[role="treeitem"]').length === 1`);
  await evaluate(`${root}.querySelector('input').value = ''; ${root}.querySelector('input').dispatchEvent(new Event('input', {bubbles:true}));`);
  await evaluate(`${root}.querySelector('[aria-label="Collapse repository tree"]').click();
    ${root}.querySelector('[aria-label="Open repository tree"]').click();`);
  await wait("syntheticWrites.length === 2");
  storageWrites.push(...await evaluate("syntheticWrites"));
  assert.deepEqual(storageWrites, [
    { "repotreex.preferences": { panelOpen: false, panelWidth: 300 } },
    { "repotreex.preferences": { panelOpen: true, panelWidth: 300 } },
  ]);
  // Fail open-state persistence, then recover with a width change: the later
  // write must contain both intentions, with the notice retained while pending.
  await evaluate(`syntheticFailSaves=1; syntheticHoldSaves=true;
    ${root}.querySelector('[aria-label="Collapse repository tree"]').click();
    ${root}.querySelector('.resizer').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));`);
  await wait("syntheticSaveGates.length === 1");
  await wait(`${root}.querySelector('.status').textContent.includes('not saved')`);
  assert.deepEqual(await evaluate("syntheticWrites.at(-1)"), { "repotreex.preferences": { panelOpen: false, panelWidth: 316 } });
  await evaluate("syntheticHoldSaves=false; syntheticSaveGates.shift()()");
  await wait(`${root}.querySelector('.status').textContent.includes('not saved') === false`);
  assert.deepEqual(await evaluate("syntheticStored"), { "repotreex.preferences": { panelOpen: false, panelWidth: 316 } });
  await evaluate(`${root}.querySelector('[aria-label="Open repository tree"]').click()`);
  await wait("syntheticStored['repotreex.preferences'].panelOpen === true");
  // Detached same-session traversal still owns the throttle, not selection.
  mode = "delay"; await evaluate(`${root}.querySelector('[aria-label="Load full tree for search"]').click()`);
  await wait(`${root}.querySelector('[data-path="docs"]').getAttribute('aria-busy') === 'true'`);
  await page.evaluate(() => history.pushState({}, "", "/acme/platform/repo/-/blob/release/v1/patch/a.ts"));
  await wait(`${root}.querySelector('[aria-selected="true"]')?.dataset.path === 'a.ts'`);
  assert.ok(delayed); await delayed.fulfill({ status: 429, json: {} }); delayed = undefined;
  await wait(`${root}.querySelector('[aria-label="Load full tree for search"]').disabled === true`);
  const throttledCalls = apiRequests.length;
  await evaluate(`${root}.querySelector('[aria-label="Load full tree for search"]').click()`);
  assert.equal(apiRequests.length, throttledCalls);
  mode = "normal"; await evaluate(`${root}.querySelector('[data-action="retry-directory"][data-path="docs"]').click()`);
  await wait(`${root}.querySelector('[aria-label="Load full tree for search"]').disabled === false`);
  await evaluate(`${root}.querySelector('[aria-label="Refresh repository tree"]').click()`);
  await wait(`${root}.querySelector('[aria-selected="true"]')?.dataset.path === 'a.ts'`);
  // A matching failed ancestor retry resumes reveal; full search is not the
  // owner and must leave that failure visible even after loading the directory.
  mode = "rate";
  await page.evaluate(() => history.pushState({}, "", "/acme/platform/repo/-/blob/release/v1/patch/docs/guide.md"));
  await wait(`${root}.querySelector('[aria-label="Retry repository tree"]') !== null`);
  mode = "normal"; await evaluate(`${root}.querySelector('[data-action="retry-directory"][data-path="docs"]').click()`);
  await wait(`${root}.querySelector('[aria-selected="true"]')?.dataset.path === 'docs/guide.md'`);
  assert.equal(await evaluate(`${root}.querySelector('[aria-label="Retry repository tree"]')`), null);
  await page.evaluate(() => history.pushState({}, "", "/acme/platform/repo/-/blob/release/v1/patch/b.ts"));
  await wait(`${root}.querySelector('[aria-selected="true"]')?.dataset.path === 'b.ts'`);
  await evaluate(`${root}.querySelector('[aria-label="Refresh repository tree"]').click()`);
  await wait(`${root}.querySelector('[aria-selected="true"]')?.dataset.path === 'b.ts'`);
  mode = "server";
  await page.evaluate(() => history.pushState({}, "", "/acme/platform/repo/-/blob/release/v1/patch/docs/guide.md"));
  await wait(`${root}.querySelector('[aria-label="Retry repository tree"]') !== null`);
  mode = "normal";
  await evaluate(`${root}.querySelector('[aria-label="Load full tree for search"]').click()`);
  await wait(`${root}.querySelector('[aria-label="Load full tree for search"]') !== null && ${root}.querySelector('[data-path="docs/guide.md"]') !== null`);
  assert.notEqual(await evaluate(`${root}.querySelector('[aria-label="Retry repository tree"]')`), null);
  assert.equal(await evaluate(`${root}.querySelector('[aria-selected="true"]')`), null);
  await evaluate(`${root}.querySelector('[aria-label="Retry repository tree"]').click()`);
  await wait(`${root}.querySelector('[aria-selected="true"]')?.dataset.path === 'docs/guide.md'`);
  await page.evaluate(() => history.pushState({}, "", "/acme/platform/repo/-/blob/release/v1/patch/b.ts"));
  await wait(`${root}.querySelector('[aria-selected="true"]')?.dataset.path === 'b.ts'`);
  await evaluate(`${root}.querySelector('[aria-label="Refresh repository tree"]').click()`);
  await wait(`${root}.querySelector('[aria-selected="true"]')?.dataset.path === 'b.ts'`);
  mode = "rate";
  await evaluate(`${root}.querySelector('[aria-label="Load full tree for search"]').click()`);
  await wait(`${root}.querySelector('[aria-label="Retry full-tree search"]') !== null`);
  assert.equal(await evaluate(`${root}.querySelector('[aria-label="Load full tree for search"]').disabled`), true);
  mode = "normal"; await evaluate(`${root}.querySelector('[aria-label="Retry full-tree search"]').click()`);
  await wait(`${root}.querySelector('[aria-label="Load full tree for search"]')?.disabled === false`);
  await evaluate(`${root}.querySelector('[aria-label="Refresh repository tree"]').click()`);
  await wait(`${root}.querySelector('[aria-selected="true"]')?.dataset.path === 'b.ts'`);
  // Persisted lifecycle events exercise the production BFCache resume owner.
  // This is not a claim that this intercepted page is eligible for real BFCache.
  mode = "delay"; await evaluate(`${root}.querySelector('[aria-label="Load full tree for search"]').click()`);
  await wait(`${root}.querySelector('[data-path="docs"]').getAttribute('aria-busy') === 'true'`);
  const lifetimes = await evaluate("new Set(syntheticChannels).size");
  const outgoingChannel = await evaluate("syntheticChannels.at(-1)");
  const roots = await evaluate("syntheticRoots.length");
  await evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))");
  assert.equal(await evaluate("document.getElementById('repotreex-root')"), null);
  assert.equal(await evaluate(`${root}.querySelectorAll('[data-path]').length`), 0);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).paddingLeft), "18px");
  const suspendedCalls = apiRequests.length;
  await evaluate("window.dispatchEvent(new Event('repotreex:navigation'))");
  assert.equal(apiRequests.length, suspendedCalls);
  mode = "normal";
  await evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})); window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))");
  await wait(`${root}.querySelector('[aria-selected="true"]')?.dataset.path === 'b.ts'`);
  assert.equal(await evaluate("syntheticRoots.length"), roots + 1);
  assert.equal(await evaluate("new Set(syntheticChannels).size"), lifetimes + 1);
  assert.equal(await evaluate("document.querySelectorAll('#repotreex-root').length"), 1);
  assert.ok(delayed); await delayed.fulfill({ status: 429, json: {} }); delayed = undefined;
  await wait(`syntheticResponses.some(response=>response.channel===${JSON.stringify(outgoingChannel)} && response.status===429)`);
  assert.equal(await evaluate(`${root}.querySelector('[aria-label="Load full tree for search"]').disabled`), false);
  assert.equal(await evaluate(`${root}.querySelector('[aria-selected="true"]').dataset.path`), "b.ts");
  await evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))");
  const suspendedRoots = await evaluate("syntheticRoots.length");
  await evaluate(content);
  assert.equal(await evaluate("document.getElementById('repotreex-root')"), null);
  await evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})); window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))");
  await wait(`${root}.querySelector('[aria-selected="true"]')?.dataset.path === 'b.ts'`);
  assert.equal(await evaluate("syntheticRoots.length"), suspendedRoots + 1);
  assert.equal(await evaluate("document.querySelectorAll('#repotreex-root').length"), 1);
  assert.equal(await evaluate("new Set(syntheticChannels).size"), lifetimes + 2);
  mode = "delay"; await evaluate(`${root}.querySelector('[aria-label="Load full tree for search"]').click()`);
  await wait(`${root}.querySelector('[aria-label="Cancel full-tree search"]') !== null`);
  await page.evaluate(() => history.pushState({}, "", "/profile/me"));
  await wait("document.getElementById('repotreex-root') === null");
  assert.equal(await evaluate(`${root}.querySelectorAll('[data-path]').length`), 0);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).paddingLeft), "18px");
  if (delayed) { await delayed.fulfill({ json: { type: "tree", path: "docs", name: "docs", sha: "synthetic", size: 0, entries: [] } }); delayed = undefined; }
  mode = "normal";
  await page.evaluate(() => history.pushState({}, "", "/acme/platform/repo/-/blob/release%2Fv1%2Fpatch/src/nested/app.ts"));
  await wait(`${root}?.querySelector('[aria-selected="true"]')?.dataset.path === 'src/nested/app.ts'`);
  // Ref choice goes through actual Location.assign; synthetic document routes
  // are fulfilled locally, then the new content lifetime is injected explicitly.
  await Promise.all([page.waitForURL("**/blob/dev/src/nested/app.ts"), evaluate(`${root}.querySelector('select').value = 'dev'; ${root}.querySelector('select').dispatchEvent(new Event('change', {bubbles:true}));`)]);
  await page.waitForLoadState();
  const { frameTree } = await cdp.send("Page.getFrameTree");
  ({ executionContextId: contextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "RepoTreeX synthetic fallback" }));
  await evaluate(`globalThis.chrome = { runtime:{id:'synthetic'}, storage:{local:{async get(){return {}},async set(){}}} };`);
  await page.addScriptTag({ content: bridge });
  await evaluate(content);
  await page.waitForURL("**/blob/dev#repotreex-path-not-found"); await page.waitForLoadState();
  // New document: install closed-root probe before the production entry.
  const frame = (await cdp.send("Page.getFrameTree")).frameTree.frame;
  ({ executionContextId: contextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frame.id, worldName: "RepoTreeX synthetic root" }));
  await evaluate(`globalThis.syntheticRoots=[]; const attach=Element.prototype.attachShadow;
    Element.prototype.attachShadow=function(options){const root=attach.call(this,options); if(this.id==='repotreex-root') syntheticRoots.push(root); return root;};
    globalThis.chrome={runtime:{id:'synthetic'},storage:{local:{async get(){return {}},async set(){}}}};`);
  await page.addScriptTag({ content: bridge }); await evaluate(content);
  await wait(`${root}?.querySelector('.status').textContent.includes('not available on this ref')`);
  assert.equal(await evaluate(`${root}.querySelector('select').value`), "dev");
  assert.equal(await evaluate(`${root}.querySelector('[aria-selected="true"]')`), null);
  mode = "auth";
  await evaluate(`${root}.querySelector('[data-path="docs"]').click()`);
  await wait(`${root}.querySelector('[role="alert"]').textContent.includes('login expired')`);
  assert.equal(await evaluate(`${root}.querySelectorAll('[data-path]').length`), 0);
  assert.equal(await evaluate(`${root}.querySelector('select').options.length`), 0);
  mode = "normal"; await page.evaluate(() => history.pushState({}, "", "/acme/platform/repo"));
  await wait(`${root}.querySelector('[data-path="a.ts"]') !== null`);
  await evaluate(content);
  await wait("document.querySelectorAll('#repotreex-root').length === 1 && syntheticRoots.length === 2");
  assert.equal(await evaluate("syntheticRoots[0].host.isConnected"), false);
  await evaluate("chrome.runtime.id = undefined");
  await wait("document.getElementById('repotreex-root') === null");
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  assert.equal(await evaluate("Object.hasOwn(window, Symbol.for('repotreex.instance'))"), false);
  assert.deepEqual(errors, []);
  assert.equal(expectedHttpDiagnostics.length, 6);
  console.log("PASS built entry in Chromium MAIN/isolated worlds: nested/slash refs, sequential ancestors, SPA cache, search, cumulative preference recovery, matching retry/reveal, search error ownership, late same-session 429 gating, BFCache persisted-event scrub/fresh-channel resume, refresh, traversal rate/retry/cancel, stale lifetime data, canonical ref fallback, auth clearing, reinjection and invalidation; synthetic traffic only, no application console errors (expected injected 401/429/503 browser diagnostics).");
} finally { await cdp.detach(); await page.close(); await browser.close(); }
