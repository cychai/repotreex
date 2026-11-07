import { afterEach, describe, expect, it, vi } from "vitest";
import { createBridgeClient, type BridgeClient } from "../src/content/bridge-client";
import { createSessionProvider, type RepositoryProvider } from "../src/content/provider";
import { RepositoryError } from "../src/shared/errors";
import { BRIDGE_REQUEST_EVENT, BRIDGE_RESPONSE_EVENT, type BridgeRequest } from "../src/shared/protocol";
import {
  blobFixture, headFixture, refPageFixture, rootFixture, treeEntriesFixture, treeFixture,
} from "./fixtures/repository";

function providerFor(data: unknown) {
  const request = vi.fn().mockResolvedValue(data);
  const dispose = vi.fn();
  return { provider: createSessionProvider({ request, dispose }), request, dispose };
}

async function expectCompatibility(promise: Promise<unknown>) {
  await expect(promise).rejects.toBeInstanceOf(RepositoryError);
  await expect(promise).rejects.toMatchObject({ code: "compatibility", message: "compatibility" });
  await promise.catch((error: unknown) => {
    if (!(error instanceof RepositoryError)) throw error;
    expect(Object.keys(error)).toEqual(["code"]);
  });
}

const calls = [
  { label: "head", run: (provider: RepositoryProvider, signal?: AbortSignal) => provider.getHead("acme/repo", signal) },
  { label: "directory", run: (provider: RepositoryProvider, signal?: AbortSignal) => provider.listDirectory("acme/repo", "main", "src", signal) },
  { label: "branches", run: (provider: RepositoryProvider, signal?: AbortSignal) => provider.listBranches("acme/repo", signal) },
  { label: "tags", run: (provider: RepositoryProvider, signal?: AbortSignal) => provider.listTags("acme/repo", signal) },
];

const refMethods = ["listBranches", "listTags"] as const;
const badStrings: unknown[] = [undefined, null, 42, true, {}, [], ""];
const badSizes: unknown[] = [undefined, null, "0", true, -1, Number.NaN, Number.POSITIVE_INFINITY];

afterEach(() => vi.restoreAllMocks());

describe("session provider", () => {
  it("normalizes all four CNB entry kinds and sends the exact directory operation", async () => {
    const { provider, request } = providerFor(treeFixture);
    const controller = new AbortController();
    await expect(provider.listDirectory("acme/repo", "release/v1", "src", controller.signal)).resolves.toEqual({
      path: "src", sha: "tree-sha", entries: [
        { kind: "directory", name: "nested", path: "src/nested", sha: "nested-sha" },
        { kind: "file", name: "a.ts", path: "src/a.ts", sha: "blob-sha" },
        { kind: "link", name: "shortcut", path: "src/shortcut", sha: "link-sha" },
        { kind: "submodule", name: "vendor", path: "src/vendor", sha: "module-sha" },
      ],
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      { type: "list-directory", repo: "acme/repo", ref: "release/v1", path: "src" },
      { signal: controller.signal },
    );
  });

  it("accepts an empty root directory without inventing a path or name", async () => {
    const { provider, request } = providerFor(rootFixture);
    await expect(provider.listDirectory("acme/repo", "main", "")).resolves.toEqual({
      path: "", sha: "root-sha", entries: [],
    });
    expect(request).toHaveBeenCalledWith({ type: "list-directory", repo: "acme/repo", ref: "main", path: "" }, { signal: undefined });
  });

  it("returns the validated head name rather than its commit hash", async () => {
    const { provider, request } = providerFor(headFixture);
    const controller = new AbortController();
    await expect(provider.getHead("acme/repo", controller.signal)).resolves.toBe("main");
    expect(request).toHaveBeenCalledExactlyOnceWith({ type: "get-head", repo: "acme/repo" }, { signal: controller.signal });
  });

  it.each([undefined, null, [], {}, "tree", blobFixture, { ...treeFixture, type: "link" }, { ...treeFixture, type: "submodule" },
    { type: "tree", entries: [{ type: "blob", path: 42 }] }, Object.create(treeFixture),
  ])("rejects malformed or non-tree content %#", async (data) => {
    await expectCompatibility(providerFor(data).provider.listDirectory("acme/repo", "main", "src"));
  });

  for (const field of ["path", "name", "sha"] as const) {
    it.each(field === "sha" ? badStrings : badStrings.slice(0, -1))(`rejects invalid tree ${field} %#`, async (value) => {
      await expectCompatibility(providerFor({ ...treeFixture, [field]: value }).provider.listDirectory("acme/repo", "main", "src"));
    });
    it(`rejects a missing tree ${field}`, async () => {
      const data = Object.fromEntries(Object.entries(treeFixture).filter(([key]) => key !== field));
      await expectCompatibility(providerFor(data).provider.listDirectory("acme/repo", "main", "src"));
    });
    it.each(badStrings)(`rejects invalid entry ${field} %#`, async (value) => {
      const data = { ...treeFixture, entries: [{ ...treeEntriesFixture[1], [field]: value }] };
      await expectCompatibility(providerFor(data).provider.listDirectory("acme/repo", "main", "src"));
    });
  }

  it.each(badSizes)("rejects invalid required tree size %#", async (size) => {
    await expectCompatibility(providerFor({ ...treeFixture, size }).provider.listDirectory("acme/repo", "main", "src"));
  });

  it("rejects a missing tree size", async () => {
    const data: Record<string, unknown> = { ...treeFixture };
    delete data.size;
    await expectCompatibility(providerFor(data).provider.listDirectory("acme/repo", "main", "src"));
  });

  it.each(badSizes)("rejects invalid present optional entry size %#", async (size) => {
    const data = { ...treeFixture, entries: [{ ...treeEntriesFixture[1], size }] };
    await expectCompatibility(providerFor(data).provider.listDirectory("acme/repo", "main", "src"));
  });

  it.each([undefined, null, {}, "entries", [null], [42], [[]], [{}], new Array(1),
    [Object.create(treeEntriesFixture[1])], [{ ...treeEntriesFixture[1], type: "unknown" }],
    [{ ...treeEntriesFixture[1], type: undefined }],
  ])("rejects malformed entries or unsupported entry types %#", async (entries) => {
    await expectCompatibility(providerFor({ ...treeFixture, entries }).provider.listDirectory("acme/repo", "main", "src"));
  });

  it("rejects a malformed entry after valid entries instead of returning a partial listing", async () => {
    await expectCompatibility(providerFor({ ...treeFixture, entries: [...treeEntriesFixture, { type: "blob" }] })
      .provider.listDirectory("acme/repo", "main", "src"));
  });

  for (const field of ["name", "sha"] as const) {
    it.each(badStrings)(`rejects invalid head ${field} %#`, async (value) => {
      await expectCompatibility(providerFor({ ...headFixture, [field]: value }).provider.getHead("acme/repo"));
    });
  }

  it.each([undefined, null, [], "main", {}, Object.create(headFixture)])("rejects malformed head records %#", async (data) => {
    await expectCompatibility(providerFor(data).provider.getHead("acme/repo"));
  });

  for (const method of refMethods) {
    const kind = method === "listBranches" ? "branch" : "tag";
    const type = method === "listBranches" ? "list-branches" : "list-tags";

    it(`${method} paginates raw pages of 100, deduplicates by name, and sorts after collecting`, async () => {
      const page = refPageFixture();
      // Full duplicate pages still require the next page; first occurrence wins.
      const request = vi.fn().mockResolvedValueOnce(page).mockResolvedValueOnce(page).mockResolvedValueOnce([
        { name: "ref-050", sha: "duplicate-sha" }, { name: "aaa", sha: "aaa-sha" }, { name: "zzz", sha: "zzz-sha" },
      ]);
      const provider = createSessionProvider({ request, dispose: vi.fn() });
      const result = await provider[method]("acme/repo");
      expect(result).toHaveLength(102);
      expect(result[0]).toEqual({ kind, name: "aaa", sha: "aaa-sha" });
      expect(result[1]).toEqual({ kind, name: "ref-000", sha: "ref-sha-0" });
      expect(result[101]).toEqual({ kind, name: "zzz", sha: "zzz-sha" });
      expect(result.find((ref) => ref.name === "ref-050")).toEqual({ kind, name: "ref-050", sha: "ref-sha-50" });
      expect(result.map((ref) => ref.name)).toEqual([...result.map((ref) => ref.name)].sort());
      expect(result.every((ref) => ref.kind === kind)).toBe(true);
      expect(request.mock.calls).toEqual([1, 2, 3].map((page) => [
        { type, repo: "acme/repo", page, pageSize: 100 }, { signal: undefined },
      ]));
    });

    it(`${method} requests an empty terminal page after an exact multiple of 100`, async () => {
      const request = vi.fn().mockResolvedValueOnce(refPageFixture()).mockResolvedValueOnce([]);
      const result = await createSessionProvider({ request, dispose: vi.fn() })[method]("acme/repo");
      expect(result).toHaveLength(100);
      expect(request).toHaveBeenCalledTimes(2);
    });

    it(`${method} preserves exact slash, case, whitespace, and Unicode ref names`, async () => {
      const page = [
        { name: "release/v1", sha: "slash-sha" }, { name: "a", sha: "lower-sha" },
        { name: "A", sha: "upper-sha" }, { name: " ref ", sha: "space-sha" },
        { name: "r\u00e9f", sha: "unicode-sha" }, { name: "__proto__", sha: "prototype-sha" },
      ];
      await expect(providerFor(page).provider[method]("acme/repo")).resolves.toEqual([
        { kind, name: " ref ", sha: "space-sha" }, { kind, name: "A", sha: "upper-sha" },
        { kind, name: "__proto__", sha: "prototype-sha" }, { kind, name: "a", sha: "lower-sha" },
        { kind, name: "release/v1", sha: "slash-sha" }, { kind, name: "r\u00e9f", sha: "unicode-sha" },
      ]);
    });

    it(`${method} returns an empty first page without another request`, async () => {
      const { provider, request } = providerFor([]);
      await expect(provider[method]("acme/repo")).resolves.toEqual([]);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it.each([undefined, null, {}, { entries: [] }, "refs", [null], [42], [[]], [{}], new Array(1),
      [Object.create(headFixture)], [...refPageFixture(), headFixture],
    ])(`${method} rejects malformed or oversized pages %#`, async (data) => {
      await expectCompatibility(providerFor(data).provider[method]("acme/repo"));
    });

    for (const field of ["name", "sha"] as const) {
      it.each(badStrings)(`${method} rejects invalid ref ${field} %#`, async (value) => {
        await expectCompatibility(providerFor([{ ...headFixture, [field]: value }]).provider[method]("acme/repo"));
      });
    }

    it(`${method} validates duplicate records instead of skipping malformed duplicates`, async () => {
      const request = vi.fn().mockResolvedValueOnce(refPageFixture()).mockResolvedValueOnce([{ name: "ref-000" }]);
      await expectCompatibility(createSessionProvider({ request, dispose: vi.fn() })[method]("acme/repo"));
      expect(request).toHaveBeenCalledTimes(2);
    });

    it(`${method} stops between pages if the signal fires even when the client resolves late`, async () => {
      const controller = new AbortController();
      const request = vi.fn().mockImplementation(async () => {
        controller.abort("synthetic reason");
        return refPageFixture();
      });
      const promise = createSessionProvider({ request, dispose: vi.fn() })[method]("acme/repo", controller.signal);
      await expect(promise).rejects.toMatchObject({ code: "cancelled", message: "cancelled" });
      expect(request).toHaveBeenCalledExactlyOnceWith({ type, repo: "acme/repo", page: 1, pageSize: 100 }, { signal: controller.signal });
    });

    it(`${method} propagates a later page failure without returning partial refs`, async () => {
      const error = new RepositoryError("rate-limited", { status: 429, retryAfter: 30 });
      const request = vi.fn().mockResolvedValueOnce(refPageFixture()).mockRejectedValueOnce(error);
      await expect(createSessionProvider({ request, dispose: vi.fn() })[method]("acme/repo")).rejects.toBe(error);
    });
  }

  it("copies normalized data and drops unknown response metadata without mutating fixtures", async () => {
    const entry = Object.freeze({ ...treeEntriesFixture[1], extra: "synthetic-extra" });
    const tree = Object.freeze({ ...treeFixture, entries: Object.freeze([entry]), extra: "synthetic-extra" });
    const listing = await providerFor(tree).provider.listDirectory("acme/repo", "main", "src");
    expect(listing).toEqual({ path: "src", sha: "tree-sha", entries: [{ kind: "file", name: "a.ts", path: "src/a.ts", sha: "blob-sha" }] });
    expect(listing.entries[0]).not.toBe(entry);
    listing.entries[0].name = "changed";
    expect(entry.name).toBe("a.ts");
  });

  it("does not retain ref responses between calls or forward additional fields", async () => {
    const request = vi.fn().mockResolvedValueOnce([{ ...headFixture, extra: "synthetic-extra" }]).mockResolvedValueOnce([]);
    const provider = createSessionProvider({ request, dispose: vi.fn() });
    await expect(provider.listBranches("acme/repo")).resolves.toEqual([{ kind: "branch", name: "main", sha: "head-sha" }]);
    await expect(provider.listBranches("acme/repo")).resolves.toEqual([]);
    expect(request.mock.calls.map(([operation]) => operation.page)).toEqual([1, 1]);
  });

  it.each(calls)("rejects pre-aborted $label without making a client request", async ({ run }) => {
    const { provider, request } = providerFor(treeFixture);
    const controller = new AbortController();
    controller.abort("synthetic reason");
    await expect(run(provider, controller.signal)).rejects.toMatchObject({ code: "cancelled", message: "cancelled" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(calls)("rejects $label when aborted before an already-resolved response is consumed", async ({ run }) => {
    const { provider } = providerFor(rootFixture);
    const controller = new AbortController();
    const promise = run(provider, controller.signal);
    controller.abort("synthetic reason");
    await expect(promise).rejects.toMatchObject({ code: "cancelled" });
  });

  it.each(calls)("rejects $label if abort lands between request settlement and normalization", async ({ label, run }) => {
    const data = label === "head" ? headFixture : label === "directory" ? treeFixture : [headFixture];
    const { provider } = providerFor(data);
    const controller = new AbortController();
    const promise = run(provider, controller.signal);
    queueMicrotask(() => controller.abort("synthetic reason"));
    await expect(promise).rejects.toMatchObject({ code: "cancelled" });
  });

  it.each(calls)("cancels in-flight $label through the real typed bridge and ignores late responses", async ({ run }) => {
    const client = createBridgeClient(window, "synthetic-channel");
    const provider = createSessionProvider(client);
    const controller = new AbortController();
    let request: BridgeRequest | undefined;
    const listener = (event: Event) => {
      if (event instanceof CustomEvent) request = event.detail;
    };
    window.addEventListener(BRIDGE_REQUEST_EVENT, listener);
    try {
      const promise = run(provider, controller.signal);
      const rejection = expect(promise).rejects.toMatchObject({ code: "cancelled", message: "cancelled" });
      controller.abort("synthetic reason");
      await rejection;
      expect(request).toBeDefined();
      if (!request) throw new Error("Expected a synthetic bridge request");
      window.dispatchEvent(new CustomEvent(BRIDGE_RESPONSE_EVENT, {
        detail: { channel: request.channel, requestId: request.requestId, ok: true, status: 200, data: treeFixture },
      }));
      await expect(promise).rejects.toMatchObject({ code: "cancelled" });
    } finally {
      window.removeEventListener(BRIDGE_REQUEST_EVENT, listener);
      provider.dispose();
    }
  });

  it.each(calls)("propagates client errors unchanged for $label", async ({ run }) => {
    const error = new RepositoryError("forbidden", { status: 403 });
    const request = vi.fn().mockRejectedValue(error);
    await expect(run(createSessionProvider({ request, dispose: vi.fn() }))).rejects.toBe(error);
  });

  it("disposes the client exactly once and prevents provider reuse", async () => {
    const { provider, request, dispose } = providerFor(treeFixture);
    provider.dispose();
    provider.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    for (const { run } of calls) await expect(run(provider)).rejects.toMatchObject({ code: "cancelled" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(calls)("does not publish an already-resolved $label after disposal", async ({ run }) => {
    const { provider } = providerFor(treeFixture);
    const promise = run(provider);
    provider.dispose();
    await expect(promise).rejects.toMatchObject({ code: "cancelled" });
  });

  it.each(calls)("rejects $label if disposal lands between request settlement and normalization", async ({ label, run }) => {
    const data = label === "head" ? headFixture : label === "directory" ? treeFixture : [headFixture];
    const { provider } = providerFor(data);
    const promise = run(provider);
    queueMicrotask(() => provider.dispose());
    await expect(promise).rejects.toMatchObject({ code: "cancelled" });
  });

  it("disposal cancels pending work through the real bridge", async () => {
    const client: BridgeClient = createBridgeClient(window, "synthetic-channel");
    const provider = createSessionProvider(client);
    const promise = provider.getHead("acme/repo");
    const rejection = expect(promise).rejects.toMatchObject({ code: "cancelled" });
    provider.dispose();
    await rejection;
  });
});
