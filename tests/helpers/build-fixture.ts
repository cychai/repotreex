import { execFile } from "node:child_process";
import { cp, mkdir, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const execFileAsync = promisify(execFile);

// The copied build's hard-coded default belongs only to a fresh temporary
// project. Tests never grant a replacement API a caller-selected path.
export async function createBuildFixture(parent: string): Promise<string> {
  const root = path.join(parent, "project");
  await mkdir(root);
  await cp(path.join(projectRoot, "scripts"), path.join(root, "scripts"), { recursive: true });
  await cp(path.join(projectRoot, "src"), path.join(root, "src"), { recursive: true });
  await symlink(path.join(projectRoot, "node_modules"), path.join(root, "node_modules"));
  return root;
}

export function runDefaultBuild(root: string) {
  return execFileAsync(process.execPath, [
    "--input-type=module", "-e",
    "const { buildDefaultExtension } = await import(process.argv[1]); await buildDefaultExtension();",
    pathToFileURL(path.join(root, "scripts/build.mjs")).href,
  ]);
}

export function runBuildCli(root: string) {
  return execFileAsync(process.execPath, [path.join(root, "scripts/build.mjs")]);
}

export function runReplacementWithOptions(
  root: string, options: Record<string, string>, entrypoint = "buildDefaultExtension",
) {
  return execFileAsync(process.execPath, [
    "--input-type=module", "-e",
    "const build = await import(process.argv[1]); await build[process.argv[3]](JSON.parse(process.argv[2]));",
    pathToFileURL(path.join(root, "scripts/build.mjs")).href,
    JSON.stringify(options), entrypoint,
  ]);
}

// Both roots belong to the caller's dedicated fixture. The child process uses
// only osTemporaryRoot as OS temp, regardless of checkout location or TMPDIR.
export async function createTemporaryRootModel(parent: string) {
  const canonicalParent = await realpath(parent);
  const osTemporaryRoot = path.join(canonicalParent, "os-temp");
  const outsideRoot = path.join(canonicalParent, "outside-temp");
  await Promise.all([mkdir(osTemporaryRoot), mkdir(outsideRoot)]);
  return { osTemporaryRoot, outsideRoot };
}

export function runProgrammaticOutput(
  root: string,
  entrypoint: "buildExtension" | "buildPackage",
  options: { outputRoot: string; safeRoot?: string },
  osTemporaryRoot: string,
) {
  const script = entrypoint === "buildExtension" ? "build.mjs" : "package.mjs";
  return execFileAsync(process.execPath, [
    "--input-type=module", "-e",
    "const module = await import(process.argv[1]); await module[process.argv[2]](JSON.parse(process.argv[3]));",
    pathToFileURL(path.join(root, "scripts", script)).href,
    entrypoint, JSON.stringify(options),
  ], {
    env: { ...process.env, TMPDIR: osTemporaryRoot, TMP: osTemporaryRoot, TEMP: osTemporaryRoot },
    timeout: 10_000,
  });
}
