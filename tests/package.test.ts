import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPackage } from "../scripts/package.mjs";
import packageMetadata from "../package.json";

async function packageHash(timeZone: string): Promise<string> {
  const outputRoot = await mkdtemp(path.join(tmpdir(), "repotreex-package-"));
  const archivePath = path.join(outputRoot, "repotreex-0.1.0.zip");
  try {
    await buildPackage({ outputRoot, callerTimeZone: timeZone });
    return createHash("sha256")
      .update(await readFile(archivePath))
      .digest("hex");
  } finally {
    await rm(outputRoot, { force: true, recursive: true });
  }
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
