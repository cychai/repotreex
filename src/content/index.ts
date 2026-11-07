import { createBridgeClient } from "./bridge-client";
import { createRepoTreeController } from "./controller";
import { createPreferenceStore, type PreferenceStorage } from "./preferences";
import { createSessionProvider } from "./provider";
import { createTreeStore } from "./tree-store";
import { NAVIGATION_EVENT } from "../shared/protocol";

export type ContentScriptInstance = { destroy(): void };
export type BootstrapOptions = {
  storage?: PreferenceStorage;
  development?: boolean;
  isContextValid?: () => boolean;
};
const INSTANCE = Symbol.for("repotreex.instance");
declare const chrome: {
  runtime?: { id?: string };
  storage: { local: PreferenceStorage };
};

function contextValid(): boolean {
  try { return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id); }
  catch { return false; }
}

export function bootstrapContentScript(target: Window, options: BootstrapOptions = {}): ContentScriptInstance {
  const previous: unknown = Object.getOwnPropertyDescriptor(target, INSTANCE)?.value;
  if (typeof previous === "object" && previous !== null && "destroy" in previous && typeof previous.destroy === "function") previous.destroy();
  const channel = target.crypto.randomUUID();
  const bridge = createBridgeClient(target, channel);
  const provider = createSessionProvider(bridge);
  const store = createTreeStore(provider);
  // Resolve Chrome storage on each operation so invalidation is detected safely.
  const storage: PreferenceStorage = options.storage ?? {
    async get(key) { return chrome.storage.local.get(key); },
    async set(items) { await chrome.storage.local.set(items); },
  };
  const controller = createRepoTreeController({ window: target, provider, store, preferences: createPreferenceStore(storage) });
  const valid = options.isContextValid ?? contextValid;
  let destroyed = false;
  let ready = target.document.readyState !== "loading";
  const instance: ContentScriptInstance = {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      target.document.removeEventListener("DOMContentLoaded", onReady);
      target.removeEventListener(NAVIGATION_EVENT, onNavigation); target.removeEventListener("pageshow", onNavigation);
      target.removeEventListener("pagehide", onHide); target.removeEventListener("repotreex:teardown", onHide);
      target.clearInterval(timer);
      if (Object.getOwnPropertyDescriptor(target, INSTANCE)?.value === instance) Reflect.deleteProperty(target, INSTANCE);
      controller.destroy();
    },
  };
  const onNavigation = () => {
    if (destroyed || !ready) return;
    if (!valid()) { instance.destroy(); return; }
    void controller.handleNavigation(new URL(target.location.href));
  };
  const onReady = () => { ready = true; onNavigation(); };
  const onHide = () => instance.destroy();
  Object.defineProperty(target, INSTANCE, { value: instance, configurable: true });
  target.addEventListener(NAVIGATION_EVENT, onNavigation); target.addEventListener("pageshow", onNavigation);
  target.addEventListener("pagehide", onHide);
  if (options.development) target.addEventListener("repotreex:teardown", onHide);
  const timer = target.setInterval(() => { if (!valid()) instance.destroy(); }, 1000);
  if (ready) onNavigation();
  else target.document.addEventListener("DOMContentLoaded", onReady, { once: true });
  return instance;
}

// Re-executing the bundled entry replaces the old isolated-world lifetime.
if (typeof window !== "undefined" && contextValid()) bootstrapContentScript(window);
