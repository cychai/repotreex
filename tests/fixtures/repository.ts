import type { BlobContent, HeadRef, TreeContent, TreeEntry } from "../../src/shared/protocol";

// Synthetic data only; never capture responses from an actual repository.
export const headFixture: HeadRef = { name: "main", sha: "head-sha" };

export const treeEntriesFixture: TreeEntry[] = [
  { type: "tree", name: "nested", path: "src/nested", sha: "nested-sha", size: 0 },
  { type: "blob", name: "a.ts", path: "src/a.ts", sha: "blob-sha" },
  { type: "link", name: "shortcut", path: "src/shortcut", sha: "link-sha", size: 5 },
  { type: "submodule", name: "vendor", path: "src/vendor", sha: "module-sha" },
];

export const treeFixture: TreeContent = {
  type: "tree", path: "src", name: "src", sha: "tree-sha", size: 0,
  entries: treeEntriesFixture,
};

export const rootFixture: TreeContent = {
  type: "tree", path: "", name: "", sha: "root-sha", size: 0, entries: [],
};

export const blobFixture: BlobContent = {
  type: "blob", path: "src/a.ts", name: "a.ts", sha: "blob-sha", size: 4,
  content: "test", encoding: "utf-8",
};

export function refPageFixture() {
  return Array.from({ length: 100 }, (_, index) => ({
    name: `ref-${String(index).padStart(3, "0")}`, sha: `ref-sha-${index}`,
  }));
}
