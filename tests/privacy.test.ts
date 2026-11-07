import { execFile } from "node:child_process";
import { globSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import manifest from "../src/manifest.json";

const projectRoot = path.resolve(import.meta.dirname, "..");
const execFileAsync = promisify(execFile);
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
  await execFileAsync(process.execPath, [path.join(projectRoot, "scripts/build.mjs")], {
    cwd: projectRoot,
    env: { ...process.env, REPOTREEX_OUTPUT_DIR: extensionRoot },
  });
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
    expect(manifest.content_scripts.every((script) =>
      script.matches.length === 1 && script.matches[0] === "https://cnb.cool/*",
    )).toBe(true);
    expect(manifest.permissions.some((permission) => forbiddenPermissions.includes(permission))).toBe(false);
  });

  it("keeps forbidden privacy APIs and credentials out of production source", () => {
    expectNoForbiddenRuntimeApis(productionSource);
  });

  it("allows persistent writes only through the preference adapter", () => {
    const directBrowserStorageUsers = productionTypeScriptFiles.filter((file) =>
      /\bchrome\.storage\b|\bbrowser\.storage\b/.test(readFileSync(path.join(projectRoot, file), "utf8")),
    );
    expect(directBrowserStorageUsers).toEqual([preferenceAdapter]);
    expect(productionSource).not.toMatch(/chrome\.storage\.(?:sync|session|managed)\b/);
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
    expect(builtManifest.content_scripts.every((script) => script.matches.every((match) => match === "https://cnb.cool/*"))).toBe(true);
  });
});
