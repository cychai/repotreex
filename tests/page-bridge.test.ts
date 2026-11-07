// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://cnb.cool/"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeRequest } from "../src/shared/protocol";

const request: BridgeRequest = {
  channel: "channel-a", requestId: "request-a", operation: { type: "get-head", repo: "acme/repo" },
};
const historyPrototype: object = Object.getPrototypeOf(window.history);
const pushDescriptor = Object.getOwnPropertyDescriptor(historyPrototype, "pushState");
const replaceDescriptor = Object.getOwnPropertyDescriptor(historyPrototype, "replaceState");
if (!pushDescriptor || !replaceDescriptor) throw new Error("Missing native history descriptors");

let handleBridgeRequest: typeof import("../src/page/bridge").handleBridgeRequest;
const fetchMock = vi.fn<typeof fetch>();
const listeners: [string, EventListenerOrEventListenerObject][] = [];

beforeEach(async () => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  const addListener = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
    listeners.push([type, listener]);
    addListener(type, listener, options);
  });
  ({ handleBridgeRequest } = await import("../src/page/bridge"));
});

afterEach(() => {
  for (const [type, listener] of listeners.splice(0)) window.removeEventListener(type, listener);
  Object.defineProperty(historyPrototype, "pushState", pushDescriptor);
  Object.defineProperty(historyPrototype, "replaceState", replaceDescriptor);
  Reflect.deleteProperty(window.history, "pushState");
  Reflect.deleteProperty(window.history, "replaceState");
  Reflect.deleteProperty(window, Symbol.for("repotreex.pageBridge"));
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("page bridge handler", () => {
  it("fetches the allowlisted same-origin head using exactly the active-session contract", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ name: "main", sha: "abc" })));
    await expect(handleBridgeRequest(request, fetchMock)).resolves.toEqual({
      channel: "channel-a", requestId: "request-a", ok: true, status: 200, data: { name: "main", sha: "abc" },
    });
    expect(fetchMock).toHaveBeenCalledWith("https://cnb.cool/acme/repo/-/git/head", {
      method: "GET", credentials: "include", headers: { Accept: "application/json" }, cache: "no-store",
    });
  });

  it.each([
    [{ type: "list-directory", repo: "acme/repo", ref: "release/v1", path: "src/a b" }, "https://cnb.cool/acme/repo/-/git/contents/src/a%20b?ref=release%2Fv1"],
    [{ type: "list-branches", repo: "acme/repo", page: -1, pageSize: 500 }, "https://cnb.cool/acme/repo/-/git/branches?page=1&page_size=100"],
    [{ type: "list-tags", repo: "acme/repo", page: 2, pageSize: 20 }, "https://cnb.cool/acme/repo/-/git/tags?page=2&page_size=20"],
  ])("consumes allowlist encoding and pagination %#", async (operation, url) => {
    fetchMock.mockResolvedValue(new Response("[]"));
    await expect(handleBridgeRequest({ ...request, operation }, fetchMock)).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(url, {
      method: "GET", credentials: "include", headers: { Accept: "application/json" }, cache: "no-store",
    });
  });

  it.each([[401, "signed-out"], [403, "forbidden"], [404, "not-found"], [429, "rate-limited"], [503, "server"], [302, "compatibility"]])(
    "returns only correlation/status/code for HTTP %s without reading bodies or headers", async (status, code) => {
      const response = new Response("private body", { status, headers: { "Retry-After": "30", "X-Private": "private" } });
      const json = vi.spyOn(response, "json");
      const text = vi.spyOn(response, "text");
      const headers = vi.spyOn(response.headers, "get");
      fetchMock.mockResolvedValue(response);
      await expect(handleBridgeRequest(request, fetchMock)).resolves.toEqual({
        channel: "channel-a", requestId: "request-a", ok: false, status, code,
      });
      expect(json).not.toHaveBeenCalled();
      expect(text).not.toHaveBeenCalled();
      expect(headers).not.toHaveBeenCalled();
    });

  it("classifies successful invalid JSON as compatibility without returning raw text", async () => {
    const response = new Response("<html>private login page</html>");
    const text = vi.spyOn(response, "text");
    fetchMock.mockResolvedValue(response);
    await expect(handleBridgeRequest(request, fetchMock)).resolves.toEqual({
      channel: "channel-a", requestId: "request-a", ok: false, status: 200, code: "compatibility",
    });
    expect(text).not.toHaveBeenCalled();
  });

  it.each([
    [new TypeError("private URL"), "network"],
    [new DOMException("private abort reason", "AbortError"), "cancelled"],
    [new DOMException("private URL", "NetworkError"), "network"],
  ])("sanitizes known fetch failure %#", async (error, code) => {
    fetchMock.mockRejectedValue(error);
    await expect(handleBridgeRequest(request, fetchMock)).resolves.toEqual({
      channel: "channel-a", requestId: "request-a", ok: false, status: 0, code,
    });
  });

  it.each([
    [new TypeError("private body"), "network"],
    [new DOMException("private abort reason", "AbortError"), "cancelled"],
  ])("sanitizes known JSON body-read failure %#", async (error, code) => {
    const response = new Response("{}");
    vi.spyOn(response, "json").mockRejectedValue(error);
    fetchMock.mockResolvedValue(response);
    await expect(handleBridgeRequest(request, fetchMock)).resolves.toEqual({
      channel: "channel-a", requestId: "request-a", ok: false, status: 200, code,
    });
  });

  it("does not swallow unexpected implementation failures", async () => {
    const error = new Error("Unexpected implementation failure");
    fetchMock.mockRejectedValue(error);
    await expect(handleBridgeRequest(request, fetchMock)).rejects.toBe(error);
    const response = new Response("{}");
    vi.spyOn(response, "json").mockRejectedValue(error);
    fetchMock.mockResolvedValue(response);
    await expect(handleBridgeRequest(request, fetchMock)).rejects.toBe(error);
  });

  it.each([null, [], {}, { channel: "", requestId: "a" }, { channel: "a", requestId: 7 }, { channel: "a" }])(
    "drops uncorrelatable malformed envelopes %# without fetching", async (detail) => {
      await expect(handleBridgeRequest(detail, fetchMock)).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

  it("rejects caller-supplied fetch settings on the request envelope", async () => {
    await expect(handleBridgeRequest({ ...request, credentials: "omit", method: "POST" }, fetchMock))
      .resolves.toEqual({ channel: "channel-a", requestId: "request-a", ok: false, status: 0, code: "compatibility" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects inherited request correlation fields", async () => {
    await expect(handleBridgeRequest(Object.create(request), fetchMock)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    undefined, null, [], {}, { type: "get-head", repo: 1 },
    { type: "fetch", url: "https://example.com", method: "POST" },
    { type: "get-head", repo: "acme/../repo" },
    { type: "get-head", repo: "acme/repo", url: "https://example.com" },
    { type: "get-head", repo: "acme/repo", method: "POST" },
    { type: "list-directory", repo: "acme/repo", ref: "main", path: 1 },
    { type: "list-directory", repo: "acme/repo", ref: "main", path: "../private" },
    { type: "list-directory", repo: "acme/repo", ref: "main?raw=1", path: "" },
    { type: "list-tags", repo: "acme/repo", page: "1", pageSize: 20 },
    { type: "list-branches", repo: "acme/repo", page: NaN, pageSize: 20 },
    { type: "list-tags", repo: "acme/repo", page: 1, pageSize: Infinity },
    { type: "get-head", repo: "acme/repo\ud800" },
  ])("rejects malformed or disallowed operations %# without exposing input", async (operation) => {
    await expect(handleBridgeRequest({ ...request, operation }, fetchMock)).resolves.toEqual({
      channel: "channel-a", requestId: "request-a", ok: false, status: 0, code: "compatibility",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("main-world lifetime and event wiring", () => {
  it("responds only to the fixed window request event", async () => {
    fetchMock.mockResolvedValue(new Response('{"name":"main"}'));
    window.dispatchEvent(new CustomEvent("other:request", { detail: request }));
    window.dispatchEvent(new Event("repotreex:request"));
    expect(fetchMock).not.toHaveBeenCalled();
    const response = new Promise<unknown>((resolve) => {
      window.addEventListener("repotreex:response", (event) => {
        if (event instanceof CustomEvent) resolve(event.detail);
      }, { once: true });
    });
    window.dispatchEvent(new CustomEvent("repotreex:request", { detail: request }));
    await expect(response).resolves.toEqual({
      channel: "channel-a", requestId: "request-a", ok: true, status: 200, data: { name: "main" },
    });
  });

  it("patches history and registers listeners only once across re-injection", async () => {
    const push = window.history.pushState;
    const replace = window.history.replaceState;
    const before = listeners.length;
    vi.resetModules();
    await import("../src/page/bridge");
    expect(window.history.pushState).toBe(push);
    expect(window.history.replaceState).toBe(replace);
    expect(listeners).toHaveLength(before);
    const navigation = vi.fn();
    window.addEventListener("repotreex:navigation", navigation);
    window.history.pushState({}, "", "/next");
    expect(navigation).toHaveBeenCalledTimes(1);
  });

  it("preserves prototype descriptors, native this/arguments/results, and throw behavior", () => {
    const currentPush = Object.getOwnPropertyDescriptor(historyPrototype, "pushState");
    const currentReplace = Object.getOwnPropertyDescriptor(historyPrototype, "replaceState");
    expect(currentPush).toEqual({ ...pushDescriptor, value: expect.any(Function) });
    expect(currentReplace).toEqual({ ...replaceDescriptor, value: expect.any(Function) });
    expect(Object.hasOwn(window.history, "pushState")).toBe(false);
    const navigation = vi.fn();
    window.addEventListener("repotreex:navigation", navigation);
    const state = { synthetic: true };
    expect(window.history.pushState(state, "", "/next?test=1")).toBeUndefined();
    expect(window.history.state).toEqual(state);
    expect(window.location.pathname).toBe("/next");
    expect(window.history.replaceState(null, "", "/replaced")).toBeUndefined();
    expect(window.location.pathname).toBe("/replaced");
    expect(() => Reflect.apply(window.history.pushState, {}, [null, "", "/invalid"])).toThrow();
    expect(() => window.history.replaceState(null, "", "https://example.com/")).toThrow();
    expect(navigation).toHaveBeenCalledTimes(2);
    for (const [event] of navigation.mock.calls) expect(event.detail).toBeNull();
  });

  it("preserves own method descriptors, arbitrary native return values, and the caller", async () => {
    Reflect.deleteProperty(window, Symbol.for("repotreex.pageBridge"));
    const calls: unknown[][] = [];
    const original = function (this: unknown, ...args: unknown[]) {
      calls.push([this, ...args]);
      return "native-result";
    };
    Object.defineProperty(window.history, "pushState", {
      value: original, writable: false, enumerable: false, configurable: true,
    });
    vi.resetModules();
    await import("../src/page/bridge");
    const receiver = {};
    expect(Reflect.apply(window.history.pushState, receiver, [1, "title", "/next", 4])).toBe("native-result");
    expect(calls).toEqual([[receiver, 1, "title", "/next", 4]]);
    expect(Object.getOwnPropertyDescriptor(window.history, "pushState")).toEqual({
      value: expect.any(Function), writable: false, enumerable: false, configurable: true,
    });
  });

  it("emits navigation on popstate and hashchange without URL or state metadata", () => {
    const navigation = vi.fn();
    window.addEventListener("repotreex:navigation", navigation);
    window.dispatchEvent(new PopStateEvent("popstate", { state: { private: true } }));
    window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL: "private", newURL: "private" }));
    expect(navigation).toHaveBeenCalledTimes(2);
    for (const [event] of navigation.mock.calls) expect(event.detail).toBeNull();
  });

  it("round-trips the isolated client through the installed main-world handler", async () => {
    const { createBridgeClient } = await import("../src/content/bridge-client");
    fetchMock.mockResolvedValueOnce(new Response('{"name":"main","sha":"abc"}'));
    const client = createBridgeClient(window, "round-trip", { timeoutMs: 1_000 });
    try {
      await expect(client.request({ type: "get-head", repo: "acme/repo" })).resolves.toEqual({ name: "main", sha: "abc" });
      fetchMock.mockResolvedValueOnce(new Response("private", { status: 401 }));
      await expect(client.request({ type: "get-head", repo: "acme/repo" })).rejects.toMatchObject({ code: "signed-out", status: 401 });
    } finally {
      client.dispose();
    }
  });
});
