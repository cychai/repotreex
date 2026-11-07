import { createBridgeClient } from "./bridge-client";
import { createRepoTreeController, type RepoTreeController } from "./controller";
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
const SUSPENDED = Symbol.for("repotreex.suspended");
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
  const wasSuspended = typeof previous === "object" && previous !== null
    && Object.getOwnPropertyDescriptor(previous, SUSPENDED)?.value === true;
  if (typeof previous === "object" && previous !== null && "destroy" in previous && typeof previous.destroy === "function") previous.destroy();
  // Resolve Chrome storage on each operation so invalidation is detected safely.
  const storage: PreferenceStorage = options.storage ?? {
    async get(key) { return chrome.storage.local.get(key); },
    async set(items) { await chrome.storage.local.set(items); },
  };
  let controller: RepoTreeController | null = null;
  const valid = options.isContextValid ?? contextValid;
  let destroyed = false;
  let suspended = wasSuspended;
  let timer: number | null = null;
  let ready = target.document.readyState !== "loading";
  const instance: ContentScriptInstance = {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      target.document.removeEventListener("DOMContentLoaded", onReady);
      target.removeEventListener(NAVIGATION_EVENT, onNavigation); target.removeEventListener("pageshow", onShow);
      target.removeEventListener("pagehide", onHide); target.removeEventListener("repotreex:teardown", onDestroy);
      if (timer !== null) target.clearInterval(timer); timer = null;
      if (Object.getOwnPropertyDescriptor(target, INSTANCE)?.value === instance) Reflect.deleteProperty(target, INSTANCE);
      const outgoing = controller; controller = null; outgoing?.destroy();
    },
  };
  Object.defineProperty(instance, SUSPENDED, { value: suspended, writable: true });
  const onNavigation = () => {
    if (destroyed || suspended || !ready) return;
    if (!valid()) { instance.destroy(); return; }
    if (!controller) {
      const bridge = createBridgeClient(target, target.crypto.randomUUID());
      const provider = createSessionProvider(bridge);
      const store = createTreeStore(provider);
      controller = createRepoTreeController({ window: target, provider, store, preferences: createPreferenceStore(storage) });
    }
    void controller.handleNavigation(new URL(target.location.href));
  };
  const onReady = () => { ready = true; onNavigation(); };
  const startTimer = () => { timer ??= target.setInterval(() => { if (!valid()) instance.destroy(); }, 1000); };
  const onShow = (event: PageTransitionEvent) => {
    if (destroyed) return;
    if (event.persisted) {
      suspended = false; Object.defineProperty(instance, SUSPENDED, { value: false }); startTimer();
    }
    onNavigation();
  };
  const onHide = (event: PageTransitionEvent) => {
    if (!event.persisted) { instance.destroy(); return; }
    // Retain only the lightweight resume owner, never repository state or work.
    suspended = true;
    Object.defineProperty(instance, SUSPENDED, { value: true });
    if (timer !== null) target.clearInterval(timer); timer = null;
    const outgoing = controller; controller = null; outgoing?.destroy();
  };
  const onDestroy = () => instance.destroy();
  Object.defineProperty(target, INSTANCE, { value: instance, configurable: true });
  target.addEventListener(NAVIGATION_EVENT, onNavigation); target.addEventListener("pageshow", onShow);
  target.addEventListener("pagehide", onHide);
  if (options.development) target.addEventListener("repotreex:teardown", onDestroy);
  if (!suspended) startTimer();
  if (ready) onNavigation();
  else target.document.addEventListener("DOMContentLoaded", onReady, { once: true });
  return instance;
}

// Re-executing the bundled entry replaces the old isolated-world lifetime.
if (typeof window !== "undefined" && contextValid()) bootstrapContentScript(window);
