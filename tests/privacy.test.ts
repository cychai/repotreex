import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.json";

const projectRoot = path.resolve(import.meta.dirname, "..");
const sourceFiles = globSync("src/**/*.{ts,json}", { cwd: projectRoot });
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
const sensitiveStorageKeys = new Set([
  "repo",
  "repository",
  "ref",
  "path",
  "tree",
  "node",
  "nodes",
  "expandedPath",
  "expandedPaths",
  "query",
  "search",
  "sha",
  "token",
  "cookie",
]);
const sensitiveMetadata =
  /["']?(?:repo(?:sitory)?|ref|path|tree|nodes?|expandedPaths?|query|search|sha|token|cookie)["']?\s*:/i;

function browserBuildOutput(): string {
  const files = globSync("dist/extension/**/*.{js,json}", { cwd: projectRoot });
  if (files.length === 0) {
    throw new Error("Missing browser build: run npm run build before the privacy test");
  }
  return files
    .map((file) => readFileSync(path.join(projectRoot, file), "utf8"))
    .join("\n");
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

  it("does not use cookie, analytics, or alternate persistence APIs", () => {
    expect(productionSource).not.toMatch(/\b(?:chrome|browser)\.cookies\b|\bdocument\.cookie\b/);
    expect(productionSource).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB)\b/);
    expect(productionSource).not.toMatch(/\b(?:navigator\.sendBeacon|google-analytics|googletagmanager|segment\.io|sentry\.io)\b/i);
  });

  it("limits persistent writes to panel open state and width", () => {
    const persistenceSource = readFileSync(
      path.join(projectRoot, "src/content/preferences.ts"),
      "utf8",
    );
    const serializedRecord = persistenceSource.match(
      /await storage\.set\s*\(\{([\s\S]*?)\}\s*\);/,
    )?.[1];
    expect(serializedRecord).toBeDefined();
    expect(serializedRecord).not.toMatch(sensitiveMetadata);
    expect(serializedRecord?.match(/\bpanelOpen\s*:/g)).toHaveLength(1);
    expect(serializedRecord?.match(/\bpanelWidth\s*:/g)).toHaveLength(1);
    expect(productionSource).not.toMatch(/chrome\.storage\.(?:sync|session|managed)\b/);
    expect(sourceFiles.every((file) => {
      const source = readFileSync(path.join(projectRoot, file), "utf8");
      const sensitiveTerms = [...sensitiveStorageKeys].join("|");
      return !new RegExp(
        `(?:storage|local)\\.(?:set|setItem)\\s*\\([\\s\\S]{0,500}?["']?(?:${sensitiveTerms})["']?\\s*:`,
        "i",
      ).test(source);
    })).toBe(true);
  });

  it("contains no production metadata logging or OAuth credentials", () => {
    expect(productionSource).not.toMatch(/\bconsole\.(?:log|info|warn|error|debug|trace)\s*\(/);
    expect(productionSource).not.toMatch(/\bclient[_-]?secret\b\s*[:=]|\bclient[_-]?id\b\s*[:=]|\bBearer\s+[A-Za-z0-9._~-]+/i);
  });

  it("preserves the same privacy boundary in the browser build", () => {
    const output = browserBuildOutput();
    expect(output).not.toMatch(/\b(?:chrome|browser)\.cookies\b|\bdocument\.cookie\b/);
    expect(output).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB)\b/);
    expect(output).not.toMatch(/\bconsole\.(?:log|info|warn|error|debug|trace)\s*\(/);
    expect(output).not.toMatch(/\bclient[_-]?secret\b\s*[:=]|\bclient[_-]?id\b\s*[:=]|\bBearer\s+[A-Za-z0-9._~-]+/i);
  });
});
