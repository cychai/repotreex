// @vitest-environment node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildPackage } from "../scripts/package.mjs";
import packageMetadata from "../package.json";

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
});
