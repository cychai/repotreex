import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPreferenceStore, type Preferences, type PreferenceStorage,
} from "../src/content/preferences";

const STORAGE_KEY = "repotreex.preferences";

function memoryStorage(initial: Record<string, unknown> = {}) {
  const storage: PreferenceStorage & { value: Record<string, unknown> } = {
    value: initial,
    get: vi.fn(async (): Promise<Record<string, unknown>> => storage.value),
    set: vi.fn(async (items: Record<string, unknown>) => {
      storage.value = items;
    }),
  };
  return storage;
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("preference store", () => {
  it("persists only the explicit non-sensitive panel keys", async () => {
    const storage = memoryStorage();
    const store = createPreferenceStore(storage);

    await expect(store.save({ panelOpen: false, panelWidth: 412 })).resolves.toEqual({
      panelOpen: false,
      panelWidth: 412,
    });
    expect(storage.value).toEqual({
      [STORAGE_KEY]: { panelOpen: false, panelWidth: 412 },
    });
  });

  it("loads only own allowlisted values and ignores repository-shaped data", async () => {
    const inherited = { panelOpen: false, panelWidth: 500 };
    const stored = Object.assign(Object.create(inherited) as Record<string, unknown>, {
      panelOpen: true,
      panelWidth: 320,
      repo: "private/repo",
      ref: "secret-ref",
      path: "secret/path",
      node: { path: "secret/path" },
      expandedPaths: ["secret"],
      selection: "secret/path",
      search: "secret-query",
      session: "secret-session",
      token: "secret-token",
    });
    const storage = memoryStorage({ [STORAGE_KEY]: stored });

    await expect(createPreferenceStore(storage).load()).resolves.toEqual({
      panelOpen: true,
      panelWidth: 320,
    });
  });

  it("uses defaults for missing or invalid values and clamps finite widths", async () => {
    await expect(createPreferenceStore(memoryStorage()).load()).resolves.toEqual({
      panelOpen: true,
      panelWidth: 300,
    });

    const invalid = memoryStorage({
      [STORAGE_KEY]: { panelOpen: "false", panelWidth: Number.NaN },
    });
    await expect(createPreferenceStore(invalid).load()).resolves.toEqual({
      panelOpen: true,
      panelWidth: 300,
    });

    const tooNarrow = memoryStorage({ [STORAGE_KEY]: { panelWidth: -1 } });
    await expect(createPreferenceStore(tooNarrow).load()).resolves.toEqual({
      panelOpen: true,
      panelWidth: 240,
    });

    const tooWide = memoryStorage({ [STORAGE_KEY]: { panelOpen: false, panelWidth: 10_000 } });
    await expect(createPreferenceStore(tooWide).load()).resolves.toEqual({
      panelOpen: false,
      panelWidth: 560,
    });
  });

  it("merges valid patch values with sanitized stored preferences", async () => {
    const storage = memoryStorage({
      [STORAGE_KEY]: { panelOpen: false, panelWidth: 350, repo: "private/repo" },
    });
    const patch = {
      panelOpen: "invalid",
      panelWidth: 700,
      repository: "private/repo",
      selectedPath: "secret/path",
    } as unknown as Partial<Preferences>;

    await expect(createPreferenceStore(storage).save(patch)).resolves.toEqual({
      panelOpen: false,
      panelWidth: 560,
    });
    expect(storage.value).toEqual({
      [STORAGE_KEY]: { panelOpen: false, panelWidth: 560 },
    });
  });

  it("never reads or persists hostile unknown accessors", async () => {
    let sensitiveReads = 0;
    const patch = Object.defineProperties({}, {
      panelOpen: { value: false, enumerable: true },
      panelWidth: { value: 400, enumerable: true },
      repo: {
        enumerable: true,
        get() {
          sensitiveReads += 1;
          throw new Error("sensitive accessor executed");
        },
      },
      token: {
        enumerable: true,
        get() {
          sensitiveReads += 1;
          return "secret-token";
        },
      },
    }) as Partial<Preferences>;
    const storage = memoryStorage();

    await expect(createPreferenceStore(storage).save(patch)).resolves.toEqual({
      panelOpen: false,
      panelWidth: 400,
    });
    expect(sensitiveReads).toBe(0);
    expect(storage.value).toEqual({
      [STORAGE_KEY]: { panelOpen: false, panelWidth: 400 },
    });
  });

  it("does not execute allowlisted accessors from stored or caller objects", async () => {
    let accessorReads = 0;
    const stored = Object.defineProperties({}, {
      panelOpen: {
        enumerable: true,
        get() {
          accessorReads += 1;
          return false;
        },
      },
      panelWidth: { value: 320, enumerable: true },
      search: {
        enumerable: true,
        get() {
          accessorReads += 1;
          return "secret-query";
        },
      },
    });
    const patch = Object.defineProperty({}, "panelWidth", {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 500;
      },
    }) as Partial<Preferences>;
    const storage = memoryStorage({ [STORAGE_KEY]: stored });

    await expect(createPreferenceStore(storage).save(patch)).resolves.toEqual({
      panelOpen: true,
      panelWidth: 320,
    });
    expect(accessorReads).toBe(0);
    expect(storage.value).toEqual({
      [STORAGE_KEY]: { panelOpen: true, panelWidth: 320 },
    });
  });

  it("rejects a hostile storage result before inspecting preference data", async () => {
    const storage = memoryStorage();
    storage.value = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error("storage descriptor trap");
      },
    });

    await expect(createPreferenceStore(storage).load()).rejects.toThrow(TypeError);
    await expect(createPreferenceStore(storage).save({ panelOpen: false })).rejects.toThrow(TypeError);
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("rejects descriptor-hostile values without attempting a write", async () => {
    const storage = memoryStorage();
    const patch = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error("descriptor trap");
      },
    }) as Partial<Preferences>;

    await expect(createPreferenceStore(storage).save(patch)).rejects.toThrow(TypeError);
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("propagates storage read and write errors unchanged", async () => {
    const readError = new Error("read failed");
    const readStorage: PreferenceStorage = {
      get: vi.fn().mockRejectedValue(readError),
      set: vi.fn(),
    };
    await expect(createPreferenceStore(readStorage).load()).rejects.toBe(readError);
    await expect(createPreferenceStore(readStorage).save({ panelOpen: false })).rejects.toBe(readError);
    expect(readStorage.set).not.toHaveBeenCalled();

    const writeError = new Error("write failed");
    const writeStorage: PreferenceStorage = {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockRejectedValue(writeError),
    };
    await expect(createPreferenceStore(writeStorage).save({ panelOpen: false })).rejects.toBe(writeError);
  });

  it("adapts the MV3 local storage promise API when no test storage is supplied", async () => {
    const get = vi.fn().mockResolvedValue({
      [STORAGE_KEY]: { panelOpen: false, panelWidth: 333 },
    });
    const set = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", { storage: { local: { get, set } } });

    const store = createPreferenceStore();
    await expect(store.load()).resolves.toEqual({ panelOpen: false, panelWidth: 333 });
    await expect(store.save({ panelWidth: 444 })).resolves.toEqual({ panelOpen: false, panelWidth: 444 });
    expect(get).toHaveBeenCalledWith(STORAGE_KEY);
    expect(set).toHaveBeenCalledWith({
      [STORAGE_KEY]: { panelOpen: false, panelWidth: 444 },
    });
  });
});
