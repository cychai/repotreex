import { execFile } from "node:child_process";
import { cp, mkdir, symlink } from "node:fs/promises";
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
