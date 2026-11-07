export interface Preferences {
  panelOpen: boolean;
  panelWidth: number;
}

export interface PreferenceStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface PreferenceStore {
  load(): Promise<Preferences>;
  save(patch: Partial<Preferences>): Promise<Preferences>;
}

declare const chrome: {
  storage: {
    local: PreferenceStorage;
  };
};

const STORAGE_KEY = "repotreex.preferences";
const DEFAULT_PANEL_OPEN = true;
const DEFAULT_PANEL_WIDTH = 300;
const MIN_PANEL_WIDTH = 240;
const MAX_PANEL_WIDTH = 560;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;

function ownDataValue(record: object, key: keyof Preferences): unknown {
  const descriptor = getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function readPreferences(value: unknown): Preferences {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { panelOpen: DEFAULT_PANEL_OPEN, panelWidth: DEFAULT_PANEL_WIDTH };
  }

  let panelOpen: unknown;
  let panelWidth: unknown;
  try {
    panelOpen = ownDataValue(value, "panelOpen");
    panelWidth = ownDataValue(value, "panelWidth");
  } catch {
    throw new TypeError("Unable to inspect preferences");
  }

  return {
    panelOpen: typeof panelOpen === "boolean" ? panelOpen : DEFAULT_PANEL_OPEN,
    panelWidth: typeof panelWidth === "number" && Number.isFinite(panelWidth)
      ? Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, panelWidth))
      : DEFAULT_PANEL_WIDTH,
  };
}

function mergePreferences(current: Preferences, patch: Partial<Preferences>): Preferences {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new TypeError("Preference patch must be an object");
  }

  let panelOpen: unknown;
  let panelWidth: unknown;
  try {
    panelOpen = ownDataValue(patch, "panelOpen");
    panelWidth = ownDataValue(patch, "panelWidth");
  } catch {
    throw new TypeError("Unable to inspect preference patch");
  }

  return {
    panelOpen: typeof panelOpen === "boolean" ? panelOpen : current.panelOpen,
    panelWidth: typeof panelWidth === "number" && Number.isFinite(panelWidth)
      ? Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, panelWidth))
      : current.panelWidth,
  };
}

function chromeLocalStorage(): PreferenceStorage {
  let local: PreferenceStorage;
  try {
    local = chrome.storage.local;
  } catch {
    throw new TypeError("Preference storage is unavailable");
  }
  return {
    async get(key) {
      return local.get(key) as Promise<Record<string, unknown>>;
    },
    async set(items) {
      await local.set(items);
    },
  };
}

export function createPreferenceStore(storage: PreferenceStorage = chromeLocalStorage()): PreferenceStore {
  const load = async (): Promise<Preferences> => {
    const stored = await storage.get(STORAGE_KEY);
    let value: unknown;
    try {
      const descriptor = getOwnPropertyDescriptor(stored, STORAGE_KEY);
      value = descriptor && "value" in descriptor ? descriptor.value : undefined;
    } catch {
      throw new TypeError("Unable to inspect stored preferences");
    }
    return readPreferences(value);
  };

  return {
    load,
    async save(patch) {
      const preferences = mergePreferences(await load(), patch);
      await storage.set({
        [STORAGE_KEY]: {
          panelOpen: preferences.panelOpen,
          panelWidth: preferences.panelWidth,
        },
      });
      return { panelOpen: preferences.panelOpen, panelWidth: preferences.panelWidth };
    },
  };
}
