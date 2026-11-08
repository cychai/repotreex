import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapContentScript } from "../src/content/index";
import { BRIDGE_REQUEST_EVENT, BRIDGE_RESPONSE_EVENT } from "../src/shared/protocol";

const cleanups: (() => void)[] = [];
function setup(ready = true, development = false) {
  const target = window;
  target.history.replaceState({}, "", "https://cnb.cool/acme/team/repo/-/blob/release/v1/a.ts");
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value() {}, configurable: true });
  Object.defineProperty(target.document, "readyState", { value: ready ? "complete" : "loading", configurable: true });
  let valid = true;
  const storage = { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) };
  const requests: {
    channel: string;
    requestId: string;
    operation: { platform: string; type: string; repository: string; ref?: string; path?: string };
  }[] = [];
  const respond = (event: Event) => {
    const request = (event as CustomEvent).detail; requests.push(request);
    const type = request.operation.type;
    const data = type === "get-head" ? { name: "main", sha: "synthetic" }
      : type === "list-branches" ? [{ name: "main", sha: "synthetic" }, { name: "release/v1", sha: "synthetic" }]
      : type === "list-tags" ? []
      : { type: "tree", name: "", path: "", sha: "synthetic", size: 0, entries: [{ type: "blob", path: "a.ts", name: "a.ts", sha: "synthetic" }] };
    target.dispatchEvent(new CustomEvent(BRIDGE_RESPONSE_EVENT, { detail: { channel: request.channel, requestId: request.requestId, ok: true, status: 200, data } }));
  };
  target.addEventListener(BRIDGE_REQUEST_EVENT, respond);
  const options = { storage, development, isContextValid: () => valid };
  const instance = bootstrapContentScript(target, options);
  cleanups.push(() => { instance.destroy(); target.removeEventListener(BRIDGE_REQUEST_EVENT, respond); });
  return { target, storage, requests, instance, options, invalidate() { valid = false; } };
}
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllGlobals(); });
describe("content-script lifetime", () => {
  it("boots the real bridge/provider/store/preferences/panel/controller with one random channel", async () => {
    const t = setup(); await vi.waitFor(() => expect(t.target.document.getElementById("repotreex-root")).not.toBeNull());
    await vi.waitFor(() => expect(t.requests.some((request) => request.operation.type === "list-directory")).toBe(true));
    expect(new Set(t.requests.map((request) => request.channel)).size).toBe(1);
    expect(t.requests[0].channel).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.requests.at(-1)?.operation).toEqual({
      platform: "cnb", type: "list-directory", repository: "acme/team/repo", ref: "release/v1", path: "",
    });
    expect(t.storage.set).not.toHaveBeenCalled();
  });
  it("destroys the previous Symbol.for instance before replacing it", async () => {
    const t = setup(); await vi.waitFor(() => expect(t.requests.length).toBe(4));
    const oldHost = t.target.document.getElementById("repotreex-root"); const oldChannel = t.requests[0].channel;
    const newer = bootstrapContentScript(t.target, t.options); cleanups.push(() => newer.destroy());
    await vi.waitFor(() => expect(t.requests.length).toBe(8));
    expect(oldHost?.isConnected).toBe(false); expect(t.target.document.querySelectorAll("#repotreex-root")).toHaveLength(1);
    expect(t.requests[4].channel).not.toBe(oldChannel);
    t.instance.destroy(); expect(t.target.document.getElementById("repotreex-root")).not.toBeNull();
  });
  it("waits for DOM readiness and destroys an older waiting lifetime", async () => {
    const t = setup(false); expect(t.requests).toHaveLength(0);
    const next = bootstrapContentScript(t.target, t.options); cleanups.push(() => next.destroy());
    t.target.document.dispatchEvent(new Event("DOMContentLoaded"));
    await vi.waitFor(() => expect(t.requests.length).toBe(4)); expect(t.target.document.querySelectorAll("#repotreex-root")).toHaveLength(1);
  });
  it.each(["repotreex:navigation", "pageshow"])("reconciles current location on %s, ignoring event metadata", async (event) => {
    const t = setup(); await vi.waitFor(() => expect(t.requests.length).toBe(4));
    t.target.history.pushState({}, "", "/profile/me");
    t.target.dispatchEvent(new CustomEvent(event, { detail: { url: "https://cnb.cool/private/secret" } }));
    await vi.waitFor(() => expect(t.target.document.getElementById("repotreex-root")).toBeNull());
    expect(t.requests).toHaveLength(4);
  });
  it.each(["pagehide", "repotreex:teardown"])("cleans up on %s and never remounts after late events", async (event) => {
    const t = setup(true, true); await vi.waitFor(() => expect(t.requests.length).toBe(4));
    t.target.dispatchEvent(new Event(event)); expect(t.target.document.getElementById("repotreex-root")).toBeNull();
    t.target.dispatchEvent(new Event("pageshow")); await new Promise((resolve) => setTimeout(resolve, 20)); expect(t.requests).toHaveLength(4);
    expect(Object.hasOwn(t.target, Symbol.for("repotreex.instance"))).toBe(false);
  });
  it("ignores development teardown in production", async () => {
    const t = setup(); await vi.waitFor(() => expect(t.requests.length).toBe(4));
    t.target.dispatchEvent(new Event("repotreex:teardown")); expect(t.target.document.getElementById("repotreex-root")).not.toBeNull();
  });
  it("detects invalidated extension context and clears without emitting metadata", async () => {
    const t = setup(); await vi.waitFor(() => expect(t.requests.length).toBe(4)); t.invalidate();
    await vi.waitFor(() => expect(t.target.document.getElementById("repotreex-root")).toBeNull(), { timeout: 2500 });
    expect(t.requests).toHaveLength(4);
  });
  it("checks context validity before starting an already-ready document", async () => {
    const t = setup(false); t.instance.destroy(); t.invalidate();
    Object.defineProperty(t.target.document, "readyState", { value: "complete", configurable: true });
    const next = bootstrapContentScript(t.target, t.options); cleanups.push(() => next.destroy());
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(t.requests).toHaveLength(0); expect(Object.hasOwn(t.target, Symbol.for("repotreex.instance"))).toBe(false);
  });
  it("scrubs persisted pagehide and resumes exactly one fresh lifetime on persisted pageshow", async () => {
    const t = setup(); await vi.waitFor(() => expect(t.requests.length).toBe(4));
    const oldHost = t.target.document.getElementById("repotreex-root");
    t.target.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    expect(oldHost?.isConnected).toBe(false);
    expect(Object.hasOwn(t.target, Symbol.for("repotreex.instance"))).toBe(true);
    t.target.dispatchEvent(new Event("repotreex:navigation"));
    expect(t.requests).toHaveLength(4);
    t.target.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    t.target.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    await vi.waitFor(() => expect(t.requests.length).toBe(8));
    expect(new Set(t.requests.map((request) => request.channel)).size).toBe(2);
    expect(t.target.document.querySelectorAll("#repotreex-root")).toHaveLength(1);
    t.target.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    t.target.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    await vi.waitFor(() => expect(t.requests.length).toBe(12));
    expect(new Set(t.requests.map((request) => request.channel)).size).toBe(3);
    t.instance.destroy(); t.target.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expect(t.target.document.getElementById("repotreex-root")).toBeNull(); expect(t.requests).toHaveLength(12);
  });
  it("replaces a suspended owner without reviving its old lifetime or leaking listeners", async () => {
    const t = setup(); await vi.waitFor(() => expect(t.requests.length).toBe(4));
    t.target.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    const next = bootstrapContentScript(t.target, t.options); cleanups.push(() => next.destroy());
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(t.requests).toHaveLength(4); expect(t.target.document.getElementById("repotreex-root")).toBeNull();
    t.target.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    await vi.waitFor(() => expect(t.requests.length).toBe(8));
    t.instance.destroy();
    expect(t.target.document.querySelectorAll("#repotreex-root")).toHaveLength(1);
    next.destroy(); t.target.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expect(t.requests).toHaveLength(8);
  });
  it("does not resume a suspended lifetime after extension invalidation", async () => {
    const t = setup(); await vi.waitFor(() => expect(t.requests.length).toBe(4));
    t.target.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })); t.invalidate();
    t.target.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expect(Object.hasOwn(t.target, Symbol.for("repotreex.instance"))).toBe(false);
    expect(t.requests).toHaveLength(4); expect(t.target.document.getElementById("repotreex-root")).toBeNull();
  });
  it("persisted hide detaches outstanding bridge responses before a fresh lifetime resumes", async () => {
    const t = setup(false);
    const stopRequest = (event: Event) => event.stopImmediatePropagation();
    t.target.addEventListener(BRIDGE_REQUEST_EVENT, stopRequest, { capture: true });
    t.target.document.dispatchEvent(new Event("DOMContentLoaded"));
    await vi.waitFor(() => expect(t.storage.get).toHaveBeenCalledTimes(1));
    t.target.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    expect(t.target.document.getElementById("repotreex-root")).toBeNull();
    t.target.removeEventListener(BRIDGE_REQUEST_EVENT, stopRequest, { capture: true });
    t.target.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    await vi.waitFor(() => expect(t.requests.length).toBe(4));
    expect(t.target.document.querySelectorAll("#repotreex-root")).toHaveLength(1);
  });
  it.each(["pagehide", "repotreex:teardown"])("final %s destroys a suspended owner permanently", async (event) => {
    const t = setup(true, true); await vi.waitFor(() => expect(t.requests.length).toBe(4));
    t.target.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    t.target.dispatchEvent(new Event(event));
    t.target.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expect(Object.hasOwn(t.target, Symbol.for("repotreex.instance"))).toBe(false);
    expect(t.target.document.getElementById("repotreex-root")).toBeNull(); expect(t.requests).toHaveLength(4);
  });
});
