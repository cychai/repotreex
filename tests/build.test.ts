// @vitest-environment node
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildExtension,
  prepareBuildOutput,
  validateBuildOutput,
} from "../scripts/build.mjs";
import { createBuildFixture, runBuildCli, runDefaultBuild, runReplacementWithOptions } from "./helpers/build-fixture";

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

  it("rejects a symbolic-link safe root without touching its target", async () => {
    const parent = await temporaryRoot();
    const target = path.join(parent, "target");
    const safeRoot = path.join(parent, "linked-root");
    const sentinel = path.join(target, "keep-me.txt");
    await mkdir(target);
    await writeFile(sentinel, "do not delete", "utf8");
    await symlink(target, safeRoot);

    await expect(prepareBuildOutput({ outputRoot: path.join(safeRoot, "extension"), safeRoot })).rejects.toThrow(/symbolic link/i);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("do not delete");
  });

  it("rejects a symbolic-link intermediate component without touching its target", async () => {
    const safeRoot = await temporaryRoot();
    const target = path.join(safeRoot, "target");
    const linkedParent = path.join(safeRoot, "linked-parent");
    const sentinel = path.join(target, "keep-me.txt");
    await mkdir(target);
    await writeFile(sentinel, "do not delete", "utf8");
    await symlink(target, linkedParent);

    await expect(prepareBuildOutput({
      outputRoot: path.join(linkedParent, "extension"),
      safeRoot,
    })).rejects.toThrow(/symbolic link/i);
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

  it("rejects an absent programmatic output leaf", async () => {
    const safeRoot = await temporaryRoot();
    await expect(buildExtension({
      outputRoot: path.join(safeRoot, "not-created"),
      safeRoot,
    })).rejects.toThrow(/caller-created/i);
  });

  it("preflights missing inputs before replacing the last usable default build", async () => {
    const root = await createBuildFixture(await temporaryRoot());
    const outputRoot = path.join(root, "dist/extension");
    const sentinel = path.join(outputRoot, "last-usable-build.txt");
    await mkdir(outputRoot, { recursive: true });
    await writeFile(sentinel, "keep", "utf8");
    await rm(path.join(root, "src/assets/icon-16.png"));

    await expect(runDefaultBuild(root)).rejects.toThrow(/Required build input/);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep");
    expect(await readdir(path.join(root, "dist"))).toEqual(["extension"]);
  });

  it("rejects a symlink default root before replacing its target build", async () => {
    const parent = await temporaryRoot();
    const root = await createBuildFixture(parent);
    const target = path.join(parent, "target-dist");
    const safeRoot = path.join(root, "dist");
    const sentinel = path.join(target, "extension", "last-usable-build.txt");
    await mkdir(path.dirname(sentinel), { recursive: true });
    await writeFile(sentinel, "keep", "utf8");
    await symlink(target, safeRoot);

    await expect(runDefaultBuild(root)).rejects.toThrow(/symbolic link/i);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep");
  });

  it("rejects a symlink source input before replacing the last usable build", async () => {
    const parent = await temporaryRoot();
    const root = await createBuildFixture(parent);
    const outputRoot = path.join(root, "dist/extension");
    const targetManifest = path.join(parent, "target-manifest.json");
    const sentinel = path.join(outputRoot, "last-usable-build.txt");
    await mkdir(outputRoot, { recursive: true });
    await writeFile(sentinel, "keep", "utf8");
    await writeFile(targetManifest, "{}", "utf8");
    await rm(path.join(root, "src/manifest.json"));
    await symlink(targetManifest, path.join(root, "src/manifest.json"));

    await expect(runDefaultBuild(root)).rejects.toThrow(/Required build input/);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep");
  });

  it.each(["buildDefaultExtension", "buildDefaultProject"])("%s does not export caller-selected destructive replacement authority", async (entrypoint) => {
    const parent = await temporaryRoot();
    const root = await createBuildFixture(parent);
    // Use the fixture's canonical hard-coded dist (accepted by the old API),
    // then ask it to delete an unrelated sibling of extension.
    const safeRoot = path.join(await realpath(root), "dist");
    const outputRoot = path.join(safeRoot, "unrelated-output");
    const sentinel = path.join(outputRoot, "keep-me.txt");
    await mkdir(outputRoot, { recursive: true });
    await writeFile(sentinel, "keep", "utf8");

    await expect(runReplacementWithOptions(root, { safeRoot, outputRoot }, entrypoint)).rejects.toThrow(/argument|option|hard-coded/i);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep");
    expect(await readdir(safeRoot)).toEqual(["unrelated-output"]);
  });

  it("replaces only the hard-coded default in a fresh normal OS temporary project", async () => {
    const root = await createBuildFixture(await temporaryRoot());
    const outputRoot = path.join(root, "dist/extension");
    await mkdir(outputRoot, { recursive: true });
    await writeFile(path.join(outputRoot, "old-build.txt"), "replace", "utf8");
    await writeFile(path.join(root, "dist/keep-me.txt"), "keep", "utf8");

    await runBuildCli(root);

    await expect(access(path.join(outputRoot, "manifest.json"))).resolves.toBeUndefined();
    await expect(access(path.join(outputRoot, "old-build.txt"))).rejects.toThrow();
    await expect(readFile(path.join(root, "dist/keep-me.txt"), "utf8")).resolves.toBe("keep");
    expect((await readdir(path.join(root, "dist"))).sort()).toEqual(["extension", "keep-me.txt"]);
  });

  it("preserves the previous default build and removes staging when compilation fails", async () => {
    const root = await createBuildFixture(await temporaryRoot());
    const outputRoot = path.join(root, "dist/extension");
    await mkdir(outputRoot, { recursive: true });
    await writeFile(path.join(outputRoot, "last-usable.txt"), "keep", "utf8");
    await writeFile(path.join(root, "src/content/index.ts"), "export const broken = ;", "utf8");

    await expect(runDefaultBuild(root)).rejects.toThrow(/Build failed/);
    await expect(readFile(path.join(outputRoot, "last-usable.txt"), "utf8")).resolves.toBe("keep");
    expect(await readdir(path.join(root, "dist"))).toEqual(["extension"]);
  });

  it.each(["inside", "outside"])("rejects symlink ancestors redirecting %s the selected temporary root", async (direction) => {
    const parent = await temporaryRoot();
    const targetParent = direction === "inside" ? parent : await temporaryRoot();
    const target = path.join(targetParent, "target");
    const linked = path.join(parent, "linked");
    await mkdir(path.join(target, "root/extension"), { recursive: true });
    await symlink(target, linked);
    const safeRoot = path.join(linked, "root");

    await expect(buildExtension({ outputRoot: path.join(safeRoot, "extension"), safeRoot })).rejects.toThrow(/symbolic link/i);
    expect(await readdir(path.join(target, "root/extension"))).toEqual([]);
  });

  it("accepts both the normal and canonical OS temporary directory spellings", async () => {
    const normalRoot = await temporaryRoot();
    const canonicalRoot = await realpath(normalRoot);
    await mkdir(path.join(normalRoot, "normal"));
    await mkdir(path.join(canonicalRoot, "canonical"));
    await buildExtension({ safeRoot: normalRoot, outputRoot: path.join(normalRoot, "normal") });
    await buildExtension({ safeRoot: canonicalRoot, outputRoot: path.join(canonicalRoot, "canonical") });
    await expect(access(path.join(normalRoot, "normal/manifest.json"))).resolves.toBeUndefined();
    await expect(access(path.join(canonicalRoot, "canonical/manifest.json"))).resolves.toBeUndefined();
  });

  it("rejects canonical directories outside OS temporary storage before writing", async () => {
    const safeRoot = await mkdtemp(path.join(projectRoot, ".superpowers/build-safety-"));
    temporaryRoots.push(safeRoot);
    const outputRoot = path.join(safeRoot, "extension");
    await mkdir(outputRoot);
    await expect(buildExtension({ safeRoot, outputRoot })).rejects.toThrow(/safe root/i);
    expect(await readdir(outputRoot)).toEqual([]);
  });

  it("rejects a temporary symlink ancestor redirected outside OS temporary storage", async () => {
    const parent = await temporaryRoot();
    const target = await mkdtemp(path.join(projectRoot, ".superpowers/build-safety-"));
    temporaryRoots.push(target);
    await mkdir(path.join(target, "root/extension"), { recursive: true });
    await symlink(target, path.join(parent, "redirect"));
    const safeRoot = path.join(parent, "redirect/root");
    await expect(buildExtension({ safeRoot, outputRoot: path.join(safeRoot, "extension") })).rejects.toThrow(/symbolic link/i);
    expect(await readdir(path.join(target, "root/extension"))).toEqual([]);
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
