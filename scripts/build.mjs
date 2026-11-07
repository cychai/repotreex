import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  assertNoSymlinkComponents, assertRealDirectory, canonicalTemporaryRoot,
  isStrictDescendant, missing, normalizeSystemPath, validateTemporaryDirectory,
} from "./output-paths.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(projectRoot, "src");
const defaultSafeRoot = path.join(projectRoot, "dist");
const defaultOutputRoot = path.join(defaultSafeRoot, "extension");
const requiredPaths = [
  "manifest.json",
  "assets/icon-16.png",
  "assets/icon-32.png",
  "assets/icon-48.png",
  "assets/icon-128.png",
  "content/index.ts",
  "content/panel.ts",
  "page/bridge.ts",
];

function isAllowedSafeRoot(safeRoot) {
  return safeRoot === defaultSafeRoot || isStrictDescendant(safeRoot, canonicalTemporaryRoot());
}

export function validateBuildOutput({ outputRoot, safeRoot }) {
  if (typeof outputRoot !== "string" || outputRoot.trim() === "" || typeof safeRoot !== "string" || safeRoot.trim() === "") {
    throw new TypeError("Build output and safe root must be non-empty paths");
  }
  const resolvedOutput = normalizeSystemPath(outputRoot);
  const resolvedSafeRoot = normalizeSystemPath(safeRoot);
  const forbiddenOutputs = new Set([path.parse(resolvedOutput).root, path.resolve(homedir()), projectRoot]);
  if (!isAllowedSafeRoot(resolvedSafeRoot)) {
    throw new Error("Build safe root must be the project dist directory or a temporary child");
  }
  if (forbiddenOutputs.has(resolvedOutput) || !isStrictDescendant(resolvedOutput, resolvedSafeRoot)) {
    throw new Error("Build output must be a dedicated leaf strictly inside its safe root");
  }
  return { outputRoot: resolvedOutput, safeRoot: resolvedSafeRoot };
}

export async function preflightBuildInputs(root = sourceRoot) {
  root = normalizeSystemPath(root);
  await assertNoSymlinkComponents(root);
  await assertRealDirectory(root, "Build source root");
  await Promise.all(requiredPaths.map(async (relativePath) => {
    const requiredPath = path.join(root, relativePath);
    try {
      await assertNoSymlinkComponents(path.dirname(requiredPath));
      if ((await lstat(requiredPath)).isSymbolicLink()) throw new Error("input is a symbolic link");
      const file = await stat(requiredPath);
      if (!file.isFile()) throw new Error("path is not a file");
    } catch (error) {
      throw new Error(`Required build input is missing or unsafe: src/${relativePath}`, { cause: error });
    }
  }));
}

async function validatePreparedOutput({ outputRoot, safeRoot }) {
  const validated = validateBuildOutput({ outputRoot, safeRoot });
  await assertNoSymlinkComponents(validated.outputRoot);
  if (validated.safeRoot !== defaultSafeRoot) await validateTemporaryDirectory(validated.safeRoot);
  await assertRealDirectory(validated.safeRoot, "Build safe root");
  await assertRealDirectory(validated.outputRoot, "Build output");
  const [canonicalSafeRoot, canonicalOutput] = await Promise.all([
    realpath(validated.safeRoot),
    realpath(validated.outputRoot),
  ]);
  if (!isStrictDescendant(canonicalOutput, canonicalSafeRoot)) {
    throw new Error("Canonical build output escapes its safe root");
  }
  if ((await readdir(validated.outputRoot)).length !== 0) {
    throw new Error("Build output directory must be empty; refusing a non-empty path");
  }
  return validated;
}

export async function prepareBuildOutput({ outputRoot, safeRoot }) {
  const validated = validateBuildOutput({ outputRoot, safeRoot });
  await assertRealDirectory(validated.safeRoot, "Build safe root");
  try {
    await assertNoSymlinkComponents(validated.outputRoot);
  } catch (error) {
    if (missing(error)) throw new Error("Build output must be a caller-created empty directory", { cause: error });
    throw error;
  }
  try {
    await assertRealDirectory(validated.outputRoot, "Build output");
  } catch (error) {
    if (missing(error) || (error instanceof Error && /no such file/i.test(error.message))) {
      throw new Error("Build output must be a caller-created empty directory", { cause: error });
    }
    throw error;
  }
  return validatePreparedOutput(validated);
}

async function emitBuild(root, outputRoot) {
  await build({
    absWorkingDir: projectRoot,
    entryPoints: requiredPaths.filter((file) => file.endsWith(".ts")).map((file) => path.join(root, file)),
    outdir: outputRoot,
    outbase: root,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    loader: { ".css": "text" },
    sourcemap: false,
    logLevel: "info",
  });
  await Promise.all([
    cp(path.join(root, "manifest.json"), path.join(outputRoot, "manifest.json")),
    cp(path.join(root, "assets"), path.join(outputRoot, "assets"), { recursive: true }),
  ]);
}

export async function buildExtension(options) {
  const { outputRoot, safeRoot } = options ?? {};
  if (outputRoot === undefined || safeRoot === undefined) {
    throw new TypeError("Programmatic builds require an explicit caller-created output and safe root");
  }
  await preflightBuildInputs(sourceRoot);
  const validated = await prepareBuildOutput({ outputRoot, safeRoot });
  await emitBuild(sourceRoot, validated.outputRoot);
  return validated;
}

export async function buildDefaultExtension() {
  if (arguments.length !== 0) throw new TypeError("Default replacement accepts no arguments; paths are hard-coded");
  await preflightBuildInputs(sourceRoot);
  const validated = validateBuildOutput({ outputRoot: defaultOutputRoot, safeRoot: defaultSafeRoot });
  await assertNoSymlinkComponents(validated.safeRoot, { allowMissingLeaf: true });
  let safeRootExists = true;
  try {
    await assertRealDirectory(validated.safeRoot, "Build safe root");
  } catch (error) {
    if (missing(error)) safeRootExists = false;
    else throw error;
  }
  if (!safeRootExists) await mkdir(validated.safeRoot);
  await assertRealDirectory(validated.safeRoot, "Build safe root");
  try {
    await assertNoSymlinkComponents(validated.outputRoot, { allowMissingLeaf: true });
  } catch (error) {
    if (!missing(error)) throw error;
  }
  // Re-check immediately before the only recursive cleanup. A hostile local
  // process can still race filesystem checks; callers must not share the root.
  await assertRealDirectory(validated.safeRoot, "Build safe root");
  const canonicalSafeRoot = await realpath(validated.safeRoot);
  if (path.resolve(canonicalSafeRoot) !== validated.safeRoot) {
    throw new Error("Build safe root changed during validation");
  }
  const stagingRoot = await mkdtemp(path.join(validated.safeRoot, ".repotreex-build-"));
  try {
    await emitBuild(sourceRoot, stagingRoot);
    try {
      await assertNoSymlinkComponents(validated.outputRoot, { allowMissingLeaf: true });
    } catch (error) {
      if (!missing(error)) throw error;
    }
    // No caller path reaches this replacement: only this project's default.
    await rm(defaultOutputRoot, { force: true, recursive: true });
    await rename(stagingRoot, validated.outputRoot);
  } catch (error) {
    await assertNoSymlinkComponents(validated.safeRoot);
    const stagingInfo = await lstat(stagingRoot).catch((error) => {
      if (missing(error)) return undefined;
      throw error;
    });
    if (stagingInfo?.isDirectory() && !stagingInfo.isSymbolicLink()) {
      await rm(stagingRoot, { force: true, recursive: true });
    }
    throw error;
  }
  return validated;
}

export async function buildDefaultProject() {
  if (arguments.length !== 0) throw new TypeError("Default replacement accepts no arguments; paths are hard-coded");
  return buildDefaultExtension();
}

if (process.argv[1] && normalizeSystemPath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildDefaultProject();
}
