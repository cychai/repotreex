import { spawn } from "node:child_process";
import { mkdir, readdir, rm, utimes } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDefaultProject, buildExtension, preflightBuildInputs } from "./build.mjs";
import { assertNoSymlinkComponents, normalizeSystemPath, validateTemporaryDirectory } from "./output-paths.mjs";
import manifest from "../src/manifest.json" with { type: "json" };

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const stableTimestamp = new Date("2000-01-01T00:00:00.000Z");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          signal
            ? `${command} terminated by signal ${signal}`
            : `${command} exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });
}

async function collectFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];

  for (const entry of entries) {
    const relativePath = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      paths.push(
        ...(await collectFiles(path.join(directory, entry.name), relativePath)),
      );
    } else if (entry.isFile()) {
      paths.push(relativePath);
    }
  }

  return paths;
}

/**
 * @param {{ outputRoot?: string }} [options]
 */
export async function buildPackage({
  outputRoot = path.join(projectRoot, "dist"),
} = {}) {
  await preflightBuildInputs();
  const resolvedOutputRoot = normalizeSystemPath(outputRoot);
  const extensionRoot = path.join(resolvedOutputRoot, "extension");
  const archivePath = path.join(resolvedOutputRoot, `repotreex-${manifest.version}.zip`);
  const isDefaultOutput = resolvedOutputRoot === path.join(projectRoot, "dist");
  if (isDefaultOutput) {
    await buildDefaultProject();
  } else {
    await validateTemporaryDirectory(resolvedOutputRoot);
    const rootEntries = await readdir(resolvedOutputRoot);
    if (rootEntries.length !== 0) {
      throw new Error("Programmatic package output must be a caller-created empty directory");
    }
    await mkdir(extensionRoot);
    // Programmatic APIs leave caller-owned output intact on failure, too.
    await buildExtension({ outputRoot: extensionRoot, safeRoot: resolvedOutputRoot });
  }

  const files = (await collectFiles(extensionRoot)).sort((left, right) =>
    left.localeCompare(right, "en"),
  );
  if (files.length === 0) throw new Error("Cannot package an empty extension build");
  await Promise.all(files.map((file) =>
    utimes(path.join(extensionRoot, file), stableTimestamp, stableTimestamp),
  ));
  await assertNoSymlinkComponents(extensionRoot);
  if (isDefaultOutput) await rm(archivePath, { force: true });
  await run("zip", ["-X", "-q", archivePath, ...files], {
    cwd: extensionRoot,
    env: { ...process.env, TZ: "UTC" },
  });
  return { archivePath, extensionRoot, files };
}

if (process.argv[1] && normalizeSystemPath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildPackage();
}
