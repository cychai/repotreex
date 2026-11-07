// @vitest-environment node
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildExtension, prepareBuildOutput, validateBuildOutput } from "../scripts/build.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "repotreex-build-safety-"));
  temporaryRoots.push(root);
  return root;
}

describe("build output safety", () => {
  it.each([
    ["filesystem root", path.parse(projectRoot).root],
    ["home directory", homedir()],
    ["repository root", projectRoot],
    ["dot", "."],
  ])("rejects the %s before filesystem mutation", async (_label, outputRoot) => {
    const safeRoot = await temporaryRoot();
    expect(() => validateBuildOutput({ outputRoot, safeRoot })).toThrow();
  });

  it("rejects the safe root itself and paths outside it", async () => {
    const safeRoot = await temporaryRoot();
    expect(() => validateBuildOutput({ outputRoot: safeRoot, safeRoot })).toThrow();
    expect(() => validateBuildOutput({ outputRoot: path.join(tmpdir(), "outside"), safeRoot })).toThrow();
    expect(() => validateBuildOutput({ outputRoot: path.dirname(safeRoot), safeRoot })).toThrow();
  });

  it("rejects the broad temporary root", () => {
    expect(() => validateBuildOutput({ outputRoot: path.join(tmpdir(), "extension"), safeRoot: tmpdir() })).toThrow();
  });

  it("rejects a non-empty leaf without deleting its contents", async () => {
    const safeRoot = await temporaryRoot();
    const outputRoot = path.join(safeRoot, "existing-output");
    const sentinel = path.join(outputRoot, "keep-me.txt");
    await mkdir(outputRoot);
    await writeFile(sentinel, "do not delete", "utf8");

    await expect(prepareBuildOutput({ outputRoot, safeRoot })).rejects.toThrow(/non-empty/i);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("do not delete");
  });

  it("rejects symbolic-link output leaves without touching their target", async () => {
    const safeRoot = await temporaryRoot();
    const target = path.join(safeRoot, "target");
    const sentinel = path.join(target, "keep-me.txt");
    await mkdir(target);
    await writeFile(sentinel, "do not delete", "utf8");
    await symlink(target, path.join(safeRoot, "extension"));

    await expect(prepareBuildOutput({ outputRoot: path.join(safeRoot, "extension"), safeRoot })).rejects.toThrow(/symbolic link/i);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("do not delete");
  });

  it("does not let ownership of one leaf authorize cleanup of another", async () => {
    const safeRoot = await temporaryRoot();
    const ownedOutput = path.join(safeRoot, "owned");
    await mkdir(ownedOutput);
    await prepareBuildOutput({ outputRoot: ownedOutput, safeRoot });
    await writeFile(path.join(ownedOutput, "generated.txt"), "generated", "utf8");

    const otherOutput = path.join(safeRoot, "other");
    const sentinel = path.join(otherOutput, "keep-me.txt");
    await mkdir(otherOutput);
    await writeFile(sentinel, "do not delete", "utf8");

    await expect(prepareBuildOutput({ outputRoot: otherOutput, safeRoot })).rejects.toThrow(/non-empty/i);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("do not delete");
  });

  it("has no environment-variable path override", () => {
    const buildSource = readFile(path.join(projectRoot, "scripts/build.mjs"), "utf8");
    return expect(buildSource).resolves.not.toContain("REPOTREEX_OUTPUT_DIR");
  });

  it("builds into a caller-created empty dedicated leaf", async () => {
    const safeRoot = await temporaryRoot();
    const outputRoot = path.join(safeRoot, "extension");
    await mkdir(outputRoot);

    await buildExtension({ outputRoot, safeRoot });

    await expect(access(path.join(outputRoot, "manifest.json"))).resolves.toBeUndefined();
  });

  it("never replaces a previously generated non-empty leaf", async () => {
    const safeRoot = await temporaryRoot();
    const outputRoot = path.join(safeRoot, "extension");
    const sibling = path.join(safeRoot, "keep-safe-root.txt");
    await mkdir(outputRoot);
    await prepareBuildOutput({ outputRoot, safeRoot });
    await writeFile(sibling, "keep", "utf8");
    await writeFile(path.join(outputRoot, "stale-generated.txt"), "stale", "utf8");

    await expect(prepareBuildOutput({ outputRoot, safeRoot })).rejects.toThrow(/non-empty/i);
    await expect(readFile(sibling, "utf8")).resolves.toBe("keep");
    await expect(readFile(path.join(outputRoot, "stale-generated.txt"), "utf8")).resolves.toBe("stale");
  });
});
