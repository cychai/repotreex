// @vitest-environment node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildPackage } from "../scripts/package.mjs";
import packageMetadata from "../package.json";

const projectRoot = path.resolve(import.meta.dirname, "..");

const expectedArchiveEntries = [
  "assets/icon-128.png",
  "assets/icon-16.png",
  "assets/icon-32.png",
  "assets/icon-48.png",
  "content/index.js",
  "content/panel.js",
  "manifest.json",
  "page/bridge.js",
];
const execFileAsync = promisify(execFile);

async function packageResult(timeZone: string): Promise<{ hash: string; files: string[] }> {
  const outputRoot = await mkdtemp(path.join(tmpdir(), "repotreex-package-"));
  const archivePath = path.join(outputRoot, "repotreex-0.1.0.zip");
  const previousTimeZone = process.env.TZ;
  try {
    process.env.TZ = timeZone;
    const { files } = await buildPackage({ outputRoot });
    const { stdout } = await execFileAsync("unzip", ["-Z1", archivePath]);
    const archiveEntries = stdout.trim().split("\n").sort((left, right) => left.localeCompare(right, "en"));
    expect(archiveEntries).toEqual(expectedArchiveEntries);
    const hash = createHash("sha256")
      .update(await readFile(archivePath))
      .digest("hex");
    return { hash, files };
  } finally {
    if (previousTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimeZone;
    await rm(outputRoot, { force: true, recursive: true });
  }
}

describe("extension package", () => {
  it("declares the Node 24 runtime required by the locked toolchain", () => {
    expect(packageMetadata.engines).toEqual({ node: ">=24.15.0 <25" });
  });

  it("is byte-identical across caller timezones", async () => {
    const utc = await packageResult("UTC");
    const shanghai = await packageResult("Asia/Shanghai");

    expect(utc.files).toEqual(expectedArchiveEntries);
    expect(shanghai.files).toEqual(expectedArchiveEntries);
    expect(shanghai.hash).toBe(utc.hash);
  });

  it("rejects a symlink package root without touching its target", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "repotreex-package-safety-"));
    const target = path.join(parent, "target");
    const outputRoot = path.join(parent, "output-link");
    const sentinel = path.join(target, "extension", "keep-me.txt");
    try {
      await mkdir(path.dirname(sentinel), { recursive: true });
      await writeFile(sentinel, "keep", "utf8");
      await symlink(target, outputRoot);

      await expect(buildPackage({ outputRoot })).rejects.toThrow(/symbolic link/i);
      await expect(readFile(sentinel, "utf8")).resolves.toBe("keep");
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("requires an empty caller-created programmatic package root", async () => {
    const outputRoot = await mkdtemp(path.join(tmpdir(), "repotreex-package-safety-"));
    const sentinel = path.join(outputRoot, "keep-me.txt");
    try {
      await writeFile(sentinel, "keep", "utf8");
      await expect(buildPackage({ outputRoot })).rejects.toThrow(/empty/i);
      await expect(readFile(sentinel, "utf8")).resolves.toBe("keep");
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("rejects a symlink ancestor even when its target stays in OS temporary storage", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "repotreex-package-safety-"));
    try {
      const target = path.join(parent, "target");
      await mkdir(path.join(target, "output"), { recursive: true });
      await symlink(target, path.join(parent, "linked"));
      await expect(buildPackage({ outputRoot: path.join(parent, "linked/output") })).rejects.toThrow(/symbolic link/i);
      expect(await readdir(path.join(target, "output"))).toEqual([]);
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("packages successfully through the canonical OS temporary path", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "repotreex-package-safety-"));
    try {
      const { files } = await buildPackage({ outputRoot: await realpath(parent) });
      expect(files).toEqual(expectedArchiveEntries);
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("rejects a real non-temporary output root before creating extension or archive", async () => {
    const outputRoot = await mkdtemp(path.join(projectRoot, ".superpowers/package-safety-"));
    try {
      await expect(buildPackage({ outputRoot })).rejects.toThrow(/canonical OS temporary root/i);
      expect(await readdir(outputRoot)).toEqual([]);
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("rejects a temporary symlink ancestor redirected outside OS temporary storage", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "repotreex-package-safety-"));
    const target = await mkdtemp(path.join(projectRoot, ".superpowers/package-safety-"));
    try {
      await mkdir(path.join(target, "output"));
      await symlink(target, path.join(parent, "redirect"));
      await expect(buildPackage({ outputRoot: path.join(parent, "redirect/output") })).rejects.toThrow(/symbolic link/i);
      expect(await readdir(path.join(target, "output"))).toEqual([]);
    } finally {
      await rm(parent, { force: true, recursive: true });
      await rm(target, { force: true, recursive: true });
    }
  });

});
