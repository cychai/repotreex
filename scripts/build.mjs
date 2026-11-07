import { cp, lstat, mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

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

function isStrictDescendant(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isAllowedSafeRoot(safeRoot) {
  const temporaryDirectory = path.resolve(tmpdir());
  return safeRoot === defaultSafeRoot || isStrictDescendant(safeRoot, temporaryDirectory);
}

/** Validate path relationships without touching the filesystem. */
export function validateBuildOutput({ outputRoot, safeRoot }) {
  if (typeof outputRoot !== "string" || outputRoot.trim() === "" || typeof safeRoot !== "string" || safeRoot.trim() === "") {
    throw new TypeError("Build output and safe root must be non-empty paths");
  }
  const resolvedOutput = path.resolve(outputRoot);
  const resolvedSafeRoot = path.resolve(safeRoot);
  const forbiddenOutputs = new Set([path.parse(resolvedOutput).root, path.resolve(homedir()), projectRoot]);
  if (!isAllowedSafeRoot(resolvedSafeRoot)) {
    throw new Error("Build safe root must be the project dist directory or a temporary child");
  }
  if (forbiddenOutputs.has(resolvedOutput) || !isStrictDescendant(resolvedOutput, resolvedSafeRoot)) {
    throw new Error("Build output must be a dedicated leaf strictly inside its safe root");
  }
  return { outputRoot: resolvedOutput, safeRoot: resolvedSafeRoot };
}

async function realDirectory(directory, description) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${description} must be a real directory, not a file or symbolic link`);
  }
}

/** Prepare only a validated empty leaf. Existing paths are never removed. */
export async function prepareBuildOutput({ outputRoot, safeRoot }) {
  const validated = validateBuildOutput({ outputRoot, safeRoot });
  let safeRootExists = true;
  try {
    await realDirectory(validated.safeRoot, "Build safe root");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") safeRootExists = false;
    else throw error;
  }
  if (!safeRootExists) await mkdir(validated.safeRoot);
  let outputExists = false;
  try {
    await realDirectory(validated.outputRoot, "Build output");
    outputExists = true;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (outputExists && (await readdir(validated.outputRoot)).length > 0) {
    throw new Error("Refusing to use an existing non-empty build directory");
  }
  if (!outputExists) await mkdir(validated.outputRoot, { recursive: false });
  return validated;
}

export async function buildExtension({ outputRoot = defaultOutputRoot, safeRoot = defaultSafeRoot } = {}) {
  const validated = validateBuildOutput({ outputRoot, safeRoot });
  await realDirectory(validated.safeRoot, "Build safe root");
  await realDirectory(validated.outputRoot, "Build output");
  if ((await readdir(validated.outputRoot)).length !== 0) {
    throw new Error("Build output directory must be empty");
  }

  await Promise.all(requiredPaths.map(async (relativePath) => {
    const requiredPath = path.join(sourceRoot, relativePath);
    try {
      const file = await stat(requiredPath);
      if (!file.isFile()) throw new Error("path is not a file");
    } catch (error) {
      throw new Error(`Required build input is missing: src/${relativePath}`, { cause: error });
    }
  }));

  await build({
    absWorkingDir: projectRoot,
    entryPoints: ["src/content/index.ts", "src/content/panel.ts", "src/page/bridge.ts"],
    outdir: validated.outputRoot,
    outbase: "src",
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    loader: { ".css": "text" },
    sourcemap: false,
    logLevel: "info",
  });
  await Promise.all([
    cp(path.join(sourceRoot, "manifest.json"), path.join(validated.outputRoot, "manifest.json")),
    cp(path.join(sourceRoot, "assets"), path.join(validated.outputRoot, "assets"), { recursive: true }),
  ]);
  return validated;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await rm(defaultOutputRoot, { force: true, recursive: true });
  await prepareBuildOutput({ outputRoot: defaultOutputRoot, safeRoot: defaultSafeRoot });
  await buildExtension();
}
