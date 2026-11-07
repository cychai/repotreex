// @vitest-environment node
import { globSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildExtension } from "../scripts/build.mjs";
import manifest from "../src/manifest.json";
import { findBrowserStorageReferences } from "./helpers/browser-storage-scan";

const projectRoot = path.resolve(import.meta.dirname, "..");
const sourceFiles = globSync("src/**/*.{ts,json}", { cwd: projectRoot }).sort();
const productionTypeScriptFiles = sourceFiles.filter((file) => file.endsWith(".ts"));
const productionSource = sourceFiles
  .map((file) => readFileSync(path.join(projectRoot, file), "utf8"))
  .join("\n");
const forbiddenPermissions = [
  "cookies",
  "webRequest",
  "webRequestBlocking",
  "history",
  "tabs",
  "activeTab",
  "clipboardRead",
  "clipboardWrite",
];
const preferenceAdapter = "src/content/preferences.ts";
const expectedBuiltFiles = [
  "assets/icon-128.png",
  "assets/icon-16.png",
  "assets/icon-32.png",
  "assets/icon-48.png",
  "content/index.js",
  "content/panel.js",
  "manifest.json",
  "page/bridge.js",
];
const expectedContentScripts = [
  {
    matches: ["https://cnb.cool/*"],
    js: ["content/index.js"],
    run_at: "document_start",
  },
  {
    matches: ["https://cnb.cool/*"],
    js: ["page/bridge.js"],
    run_at: "document_start",
    world: "MAIN",
  },
];
const forbiddenRuntimeApis = [
  /\b(?:chrome|browser)\.cookies\b|\bdocument\.cookie\b/,
  /\b(?:localStorage|sessionStorage|indexedDB)\b/,
  /\b(?:navigator\.sendBeacon|google-analytics|googletagmanager|segment\.io|sentry\.io)\b/i,
  /\bconsole\.(?:log|info|warn|error|debug|trace)\s*\(/,
  /\bclient[_-]?secret\b\s*[:=]|\bclient[_-]?id\b\s*[:=]|\bBearer\s+[A-Za-z0-9._~-]+/i,
];

let temporaryRoot = "";
let extensionRoot = "";
let buildOutput = "";

beforeAll(async () => {
  temporaryRoot = await mkdtemp(path.join(tmpdir(), "repotreex-privacy-"));
  extensionRoot = path.join(temporaryRoot, "extension");
  await mkdir(extensionRoot);
  await buildExtension({ outputRoot: extensionRoot, safeRoot: temporaryRoot });
  const files = globSync("**/*.{js,json}", { cwd: extensionRoot }).sort();
  buildOutput = (await Promise.all(files.map((file) => readFile(path.join(extensionRoot, file), "utf8")))).join("\n");
});

afterAll(async () => {
  if (temporaryRoot !== "") await rm(temporaryRoot, { force: true, recursive: true });
});

function expectNoForbiddenRuntimeApis(source: string): void {
  for (const pattern of forbiddenRuntimeApis) {
    expect(source).not.toMatch(pattern);
  }
}

describe("privacy boundary", () => {
  it("keeps the manifest on the exact least-privilege permission set", () => {
    expect(manifest.permissions).toEqual(["storage"]);
    expect(manifest.host_permissions).toEqual(["https://cnb.cool/*"]);
    expect(manifest.content_scripts).toEqual(expectedContentScripts);
    expect(manifest.permissions.some((permission) => forbiddenPermissions.includes(permission))).toBe(false);
  });

  it("keeps forbidden privacy APIs and credentials out of production source", () => {
    expectNoForbiddenRuntimeApis(productionSource);
  });

  it("allows persistent writes only through the preference adapter", () => {
    const browserStorageUsers = productionTypeScriptFiles.filter((file) =>
      findBrowserStorageReferences(
        readFileSync(path.join(projectRoot, file), "utf8"),
        file,
      ).length > 0,
    );
    expect(browserStorageUsers).toEqual([preferenceAdapter]);
    expect(productionSource).not.toMatch(/chrome\.storage\.(?:sync|session|managed)\b/);
  });

  it.each([
    ["computed", 'chrome["storage"].local.set({ anything: true });'],
    ["root alias", "const api = chrome; api.storage.local.set({ anything: true });"],
    ["storage destructuring", "const { storage } = browser; storage.local.set({ anything: true });"],
    ["area destructuring", "const { local } = chrome.storage; local.set({ anything: true });"],
    ["area alias", "const area = chrome.storage.local; area.set({ anything: true });"],
    ["spread payload", "const area = browser.storage.local; const payload = { ...input }; area.set(payload);"],
    ["destructured method", "const { set } = chrome.storage.local; set({ anything: true });"],
    ["method alias", "const write = browser.storage.local.set; write({ anything: true });"],
    ["assignment alias", "let api; api = browser; api['storage'].local.set({ anything: true });"],
    ["destructuring assignment", "let storage; ({ storage } = chrome); storage.local.set({ anything: true });"],
    ["constant computed key", "const key = 'storage'; chrome[key].local.set({ anything: true });"],
    ["TS wrappers", "((chrome as typeof chrome)!.storage).local.set({ anything: true });"],
    ["nested renamed declaration", "const { storage: { local: area } } = chrome; area.set({ ...payload });"],
    ["nested renamed assignment", "let area; ({ storage: { local: area } } = browser); area.set({ ...payload });"],
    ["alias cycle", "let a = chrome; let b = a; a = b; b = a; b.storage.local.set({ anything: true });"],
    ["parameter initializer", "function save(area = chrome.storage.local) { area.set({}); }"],
    ["destructured parameter initializer", "function save({ area = browser.storage.local } = {}) { area.set({}); }"],
    ["assignment target", "chrome.storage.local = replacement;"],
    ["compound assignment target", "browser.storage.local ||= replacement;"],
    ["constant computed declaration", "const key = 'storage'; const { [key]: store } = chrome; store.local.set({});"],
    ["constant computed assignment", "const key = 'storage'; let store; ({ [key]: store } = browser); store.local.set({});"],
    ["satisfies wrapper", "const area = (chrome satisfies unknown).storage.local; area.set({});"],
    ["optional access", "browser?.['storage']?.local?.set({});"],
    ["deferred reassignment", "let api = chrome; const later = () => { api = {}; }; api.storage.local.set({});"],
    ["deferred function reassignment", "let api = browser; function later() { api = {}; } api.storage.local.set({});"],
    ["loop scope leak", "for (let chrome of []) {} chrome.storage.local.set({});"],
    ["named function scope leak", "const fn = function chrome() {}; chrome.storage.local.set({});"],
    ["global holder", "globalThis.chrome.storage.local.set({});"],
    ["computed global holder", "const key = 'chrome'; window[key].storage.local.set({});"],
    ["benign root alias", "const api = chrome; consume(api);"],
    ["escaped root identifier", "const api = chro\\u006de; consume(api);"],
    ["shorthand root capture", "consume({ chrome });"],
    ["wrapped global holder", "(window as Window).chrome.storage.local.set({});"],
    ["satisfies global holder", "(globalThis satisfies unknown)['chrome'].storage.local.set({});"],
    ["ambient root declaration", "declare const chrome: unknown; const api = chrome;"],
    ["global-holder alias", "const holder = window; holder.chrome.storage.local.set({});"],
    ["nested global holder", "globalThis.window.browser.storage.local.set({});"],
  ])("detects %s browser-storage bypasses", { timeout: 1_000 }, (_label, source) => {
    expect(findBrowserStorageReferences(source, "mutation.ts")).not.toEqual([]);
  });

  it.each([
    ["parameter", "function save(chrome: { storage: unknown }) { chrome.storage; }"],
    ["block binding", "{ const browser = { storage: { local: fake } }; browser.storage.local.set({}); }"],
    ["nested parameter", "const run = (chrome: unknown) => (chrome as any).storage.local.set({});"],
    ["hoisted var", "function run() { chrome.storage; if (true) { var chrome = fake; } }"],
    ["hoisted function", "chrome.storage; function chrome() {}"],
    ["named function expression", "const run = function chrome() { chrome.storage; };"],
    ["loop binding", "for (let browser of list) browser.storage;"],
    ["catch binding", "try {} catch (chrome) { chrome.storage; }"],
    ["later lexical binding", "{ chrome.storage; const chrome = fake; }"],
    ["computed local object property", "const value = { chrome: fake, browser() {} }; value.chrome;"],
    ["type properties", "type Local = { chrome: unknown; browser: unknown };"],
    ["comment and literal", "// chrome.storage\nconst text = 'browser.storage';"],
    ["shadowed global holder", "function run(window: unknown) { window.chrome.storage; }"],
    ["direct runtime identity", "typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);"],
    ["shorthand local capture", "function run(chrome: unknown) { consume({ chrome }); }"],
    ["import binding", "import { fake as browser } from 'fake'; browser.storage;"],
    ["class binding", "class chrome { static storage = fake; } chrome.storage;"],
    ["switch binding", "switch (value) { case 1: browser.storage; break; default: let browser; }"],
  ])("ignores shadowed %s identifiers", { timeout: 1_000 }, (_label, source) => {
    expect(findBrowserStorageReferences(source, "shadowed.ts")).toEqual([]);
  });

  it("does not let function-body var bindings shadow parameter initializers", () => {
    expect(findBrowserStorageReferences(
      "function run(value = chrome.storage) { var chrome = fake; }", "parameters.ts",
    )).not.toEqual([]);
  });

  it("walks a large alias cycle without iterative dataflow", { timeout: 1_000 }, () => {
    const source = "let a = chrome, b = a;" + "a = b; b = a;".repeat(2_000) + "b.storage.local.set({});";
    expect(findBrowserStorageReferences(source, "bounded.ts")).not.toEqual([]);
  });

  it("serializes exactly panel open state and width through the real adapter", async () => {
    const writes: Record<string, unknown>[] = [];
    const local = {
      async get() { return {}; },
      async set(items: Record<string, unknown>) { writes.push(structuredClone(items)); },
    };
    const previousChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
    Object.defineProperty(globalThis, "chrome", { value: { storage: { local } }, configurable: true });
    try {
      const { createPreferenceStore } = await import("../src/content/preferences");
      await createPreferenceStore().save(Object.assign(Object.create(null), {
        panelOpen: false,
        panelWidth: 432,
        repo: "synthetic-private-repo",
        query: "synthetic-private-query",
      }));
    } finally {
      if (previousChrome) Object.defineProperty(globalThis, "chrome", previousChrome);
      else Reflect.deleteProperty(globalThis, "chrome");
    }
    expect(writes).toEqual([{ "repotreex.preferences": { panelOpen: false, panelWidth: 432 } }]);
  });

  it("builds isolated runtime artifacts and preserves the privacy boundary", () => {
    expect(globSync("**/*", { cwd: extensionRoot })
      .filter((file) => statSync(path.join(extensionRoot, file)).isFile())
      .sort()).toEqual(expectedBuiltFiles);
    expectNoForbiddenRuntimeApis(buildOutput);
    const builtManifest = JSON.parse(readFileSync(path.join(extensionRoot, "manifest.json"), "utf8")) as typeof manifest;
    expect(builtManifest.permissions).toEqual(["storage"]);
    expect(builtManifest.host_permissions).toEqual(["https://cnb.cool/*"]);
    expect(builtManifest.content_scripts).toEqual(expectedContentScripts);
    const builtJavaScript = globSync("**/*.js", { cwd: extensionRoot }).sort();
    const builtStorageUsers = builtJavaScript.filter((file) =>
      findBrowserStorageReferences(readFileSync(path.join(extensionRoot, file), "utf8"), file).length > 0,
    );
    expect(builtStorageUsers).toEqual(["content/index.js"]);
    const contentBundle = readFileSync(path.join(extensionRoot, "content/index.js"), "utf8");
    expect(contentBundle.match(/\bchrome\.storage\.local\b/g)).toHaveLength(1);
    expect(contentBundle.match(/repotreex\.preferences/g)).toHaveLength(1);
  });
});
