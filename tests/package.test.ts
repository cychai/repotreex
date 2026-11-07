import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import packageMetadata from "../package.json";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const archivePath = path.join(projectRoot, "dist", "repotreex-0.1.0.zip");
const packageScript = path.join(projectRoot, "scripts", "package.mjs");

async function packageHash(timeZone: string): Promise<string> {
  await execFileAsync(process.execPath, [packageScript], {
    cwd: projectRoot,
    env: { ...process.env, TZ: timeZone },
  });

  return createHash("sha256")
    .update(await readFile(archivePath))
    .digest("hex");
}

describe("extension package", () => {
  it("declares the Node 24 runtime required by the locked toolchain", () => {
    expect(packageMetadata.engines).toEqual({ node: ">=24.15.0 <25" });
  });

  it("is byte-identical across caller timezones", async () => {
    const utcHash = await packageHash("UTC");
    const shanghaiHash = await packageHash("Asia/Shanghai");

    expect(shanghaiHash).toBe(utcHash);
  });
});
