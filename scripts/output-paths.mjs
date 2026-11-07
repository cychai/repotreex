import { realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export function isStrictDescendant(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Normalize only the verified macOS system aliases, not caller-controlled
// symlinks. Every remaining ancestor is still inspected with lstat.
export function normalizeSystemPath(target) {
  const resolved = path.resolve(target);
  if (process.platform === "darwin") {
    for (const alias of ["/var", "/tmp"]) {
      const canonical = `/private${alias}`;
      if ((resolved === alias || isStrictDescendant(resolved, alias)) && realpathSync(alias) === canonical) {
        return path.join(canonical, path.relative(alias, resolved));
      }
    }
  }
  return resolved;
}

export function canonicalTemporaryRoot() {
  return realpathSync(tmpdir());
}

export function missing(error) {
  return error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

export async function assertNoSymlinkComponents(target, { allowMissingLeaf = false } = {}) {
  const resolved = normalizeSystemPath(target);
  let current = path.parse(resolved).root;
  const components = path.relative(current, resolved).split(path.sep).filter(Boolean);
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Symbolic link path component is not allowed: ${current}`);
      if (!info.isDirectory()) throw new Error(`Path component must be a directory: ${current}`);
    } catch (error) {
      if (missing(error) && allowMissingLeaf && index === components.length - 1) return;
      throw error;
    }
  }
}

export async function assertRealDirectory(directory, description) {
  const info = await lstat(directory);
  if (info.isSymbolicLink()) throw new Error(`${description} must not be a symbolic link`);
  if (!info.isDirectory()) throw new Error(`${description} must be a directory`);
}

export async function validateTemporaryDirectory(directory) {
  const resolved = normalizeSystemPath(directory);
  await assertNoSymlinkComponents(resolved);
  await assertRealDirectory(resolved, "Temporary output root");
  const canonical = await realpath(resolved);
  if (!isStrictDescendant(canonical, canonicalTemporaryRoot())) {
    throw new Error("Output root must remain strictly inside the canonical OS temporary root");
  }
  return canonical;
}
