import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceRoot = path.join(projectRoot, "src");
const outputRoot = path.join(projectRoot, "dist", "extension");
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

await Promise.all(
  requiredPaths.map(async (relativePath) => {
    const requiredPath = path.join(sourceRoot, relativePath);
    try {
      const file = await stat(requiredPath);
      if (!file.isFile()) {
        throw new Error("path is not a file");
      }
    } catch (error) {
      throw new Error(`Required build input is missing: src/${relativePath}`, {
        cause: error,
      });
    }
  }),
);

await rm(outputRoot, { force: true, recursive: true });
await mkdir(outputRoot, { recursive: true });

await build({
  absWorkingDir: projectRoot,
  entryPoints: ["src/content/index.ts", "src/content/panel.ts", "src/page/bridge.ts"],
  outdir: outputRoot,
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
  cp(
    path.join(sourceRoot, "manifest.json"),
    path.join(outputRoot, "manifest.json"),
  ),
  cp(path.join(sourceRoot, "assets"), path.join(outputRoot, "assets"), {
    recursive: true,
  }),
]);
