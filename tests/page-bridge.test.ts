// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://cnb.cool/"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeRequest } from "../src/shared/protocol";

const request: BridgeRequest = {
  channel: "channel-a", requestId: "request-a",
  operation: { platform: "cnb", type: "get-head", repository: "acme/repo" },
};
const githubRequest: BridgeRequest = {
  channel: "channel-a", requestId: "request-a",
  operation: {
    platform: "github", type: "repository-page", repository: "acme/repo",
    ref: null, path: "", view: "root",
  },
};
function responseAt(origin: "cnb" | "github", body: BodyInit | null, init: ResponseInit = {}): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", {
    value: origin === "cnb" ? "https://cnb.cool/acme/repo/-/git/head" : "https://github.com/acme/repo",
    configurable: true,
  });
  return response;
}
function jsonResponse(body: BodyInit | null, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json; charset=utf-8");
  return responseAt("cnb", body, { ...init, headers });
}
function htmlResponse(body: BodyInit | null, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "text/html; charset=utf-8");
  return responseAt("github", body, { ...init, headers });
}
function chunkedHtmlResponse(...chunks: string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(encoder.encode(chunk));
    },
  });
  return htmlResponse(body);
}
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
    fetchMock.mockResolvedValue(jsonResponse(JSON.stringify({ name: "main", sha: "abc" })));
    await expect(handleBridgeRequest(request, fetchMock)).resolves.toEqual({
      channel: "channel-a", requestId: "request-a", ok: true, status: 200,
      format: "json", data: { name: "main", sha: "abc" },
    });
    expect(fetchMock).toHaveBeenCalledWith("https://cnb.cool/acme/repo/-/git/head", {
      method: "GET", credentials: "include", headers: { Accept: "application/json" },
      cache: "no-store", redirect: "follow",
    });
  });

  it("fetches GitHub HTML with the active session and returns bounded text", async () => {
    const html = '<html><script type="application/json" data-target="react-app.embeddedData">{}</script></html>';
    fetchMock.mockResolvedValue(htmlResponse(html));
    await expect(handleBridgeRequest(githubRequest, fetchMock, "https://github.com")).resolves.toEqual({
      channel: "channel-a", requestId: "request-a", ok: true, status: 200, format: "text", text: html,
    });
    expect(fetchMock).toHaveBeenCalledWith("https://github.com/acme/repo", {
      method: "GET", credentials: "include", headers: { Accept: "text/html" },
      cache: "no-store", redirect: "follow",
    });
  });

  it("accepts exactly 2,000,000 UTF-16 units and rejects the next unit without returning a prefix", async () => {
    const boundary = "x".repeat(2_000_000);
    fetchMock.mockResolvedValueOnce(htmlResponse(boundary));
    const response = await handleBridgeRequest(githubRequest, fetchMock, "https://github.com");
    expect(response).toMatchObject({
      channel: "channel-a", requestId: "request-a", ok: true, status: 200, format: "text", text: boundary,
    });
    if (response?.ok !== true || response.format !== "text") throw new Error("Expected text response");
    expect(response.text).toHaveLength(2_000_000);

    const oversized = htmlResponse(`${boundary}x`);
    const oversizedBody = oversized.body;
    if (!oversizedBody) throw new Error("Missing response stream");
    const reader = oversizedBody.getReader();
    const cancel = vi.spyOn(reader, "cancel");
    const releaseLock = vi.spyOn(reader, "releaseLock");
    vi.spyOn(oversizedBody, "getReader").mockReturnValue(reader);
    fetchMock.mockResolvedValueOnce(oversized);
    await expect(handleBridgeRequest(githubRequest, fetchMock, "https://github.com")).resolves.toEqual({
      channel: "channel-a", requestId: "request-a", ok: false, status: 200, code: "compatibility",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("counts decoded UTF-16 units when a surrogate pair crosses stream chunks", async () => {
    fetchMock.mockResolvedValueOnce(chunkedHtmlResponse("x".repeat(1_999_998), "😀"));
    const boundary = await handleBridgeRequest(githubRequest, fetchMock, "https://github.com");
    expect(boundary).toMatchObject({ ok: true, format: "text" });
    if (boundary?.ok !== true || boundary.format !== "text") throw new Error("Expected text response");
    expect(boundary.text).toHaveLength(2_000_000);

    fetchMock.mockResolvedValueOnce(chunkedHtmlResponse("x".repeat(1_999_999), "😀"));
    await expect(handleBridgeRequest(githubRequest, fetchMock, "https://github.com")).resolves.toEqual({
      channel: "channel-a", requestId: "request-a", ok: false, status: 200, code: "compatibility",
    });
  });

  it.each([
    [{ platform: "cnb", type: "list-directory", repository: "acme/repo", ref: "release/v1", path: "src/a b" }, "https://cnb.cool/acme/repo/-/git/contents/src/a%20b?ref=release%2Fv1"],
    [{ platform: "cnb", type: "list-branches", repository: "acme/repo", page: -1, pageSize: 500 }, "https://cnb.cool/acme/repo/-/git/branches?page=1&page_size=100"],
    [{ platform: "cnb", type: "list-tags", repository: "acme/repo", page: 2, pageSize: 20 }, "https://cnb.cool/acme/repo/-/git/tags?page=2&page_size=20"],
  ])("consumes allowlist encoding and pagination %#", async (operation, url) => {
    fetchMock.mockResolvedValue(jsonResponse("[]"));
    await expect(handleBridgeRequest({ ...request, operation }, fetchMock)).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(url, {
      method: "GET", credentials: "include", headers: { Accept: "application/json" },
      cache: "no-store", redirect: "follow",
    });
  });

  it.each([[401, "signed-out"], [403, "forbidden"], [404, "not-found"], [429, "rate-limited"], [503, "server"], [302, "compatibility"]])(
    "returns only correlation/status/code for HTTP %s without reading bodies or headers", async (status, code) => {
      const response = responseAt("cnb", "private body", {
        status, headers: { "Retry-After": "30", "X-Private": "private" },
      });
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
    const response = jsonResponse("<html>private login page</html>");
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
  ])("sanitizes known body-read failure %#", async (error, code) => {
    const response = htmlResponse("{}");
    vi.spyOn(response, "text").mockRejectedValue(error);
    Object.defineProperty(response, "body", { value: null });
    fetchMock.mockResolvedValue(response);
    await expect(handleBridgeRequest(githubRequest, fetchMock, "https://github.com")).resolves.toEqual({
      channel: "channel-a", requestId: "request-a", ok: false, status: 200, code,
    });
  });

  it("does not swallow unexpected implementation failures", async () => {
    const error = new Error("Unexpected implementation failure");
    fetchMock.mockRejectedValue(error);
    await expect(handleBridgeRequest(request, fetchMock)).rejects.toBe(error);
    const response = htmlResponse("{}");
    vi.spyOn(response, "text").mockRejectedValue(error);
    Object.defineProperty(response, "body", { value: null });
    fetchMock.mockResolvedValue(response);
    await expect(handleBridgeRequest(githubRequest, fetchMock, "https://github.com")).rejects.toBe(error);
  });

  it("rejects an active-origin mismatch before fetch", async () => {
    await expect(handleBridgeRequest(githubRequest, fetchMock, "https://cnb.cool")).resolves.toEqual({
      channel: "channel-a", requestId: "request-a", ok: false, status: 0, code: "compatibility",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin final response before reading its body", async () => {
    const response = htmlResponse("private body");
    Object.defineProperty(response, "url", { value: "https://github.example/login" });
    const text = vi.spyOn(response, "text");
    const body = response.body;
    if (!body) throw new Error("Missing response stream");
    const getReader = vi.spyOn(body, "getReader");
    fetchMock.mockResolvedValue(response);
    await expect(handleBridgeRequest(githubRequest, fetchMock, "https://github.com")).resolves.toEqual({
      channel: "channel-a", requestId: "request-a", ok: false, status: 200, code: "compatibility",
    });
    expect(text).not.toHaveBeenCalled();
    expect(getReader).not.toHaveBeenCalled();
  });

  it.each([
    [githubRequest, "https://github.com", "application/json", "github"],
    [request, "https://cnb.cool", "text/html", "cnb"],
  ] as const)("rejects an unexpected successful content type for %s", async (bridgeRequest, origin, contentType, platform) => {
    const response = responseAt(platform, "private body", { headers: { "Content-Type": contentType } });
    const text = vi.spyOn(response, "text");
    fetchMock.mockResolvedValue(response);
    await expect(handleBridgeRequest(bridgeRequest, fetchMock, origin)).resolves.toEqual({
      channel: "channel-a", requestId: "request-a", ok: false, status: 200, code: "compatibility",
    });
    expect(text).not.toHaveBeenCalled();
  });

  it("lets a bounded 200 GitHub login page reach the decoder as metadata-free text", async () => {
    const loginPage = "<html><title>Sign in to GitHub</title></html>";
    fetchMock.mockResolvedValue(htmlResponse(loginPage));
    await expect(handleBridgeRequest(githubRequest, fetchMock, "https://github.com")).resolves.toEqual({
      channel: "channel-a", requestId: "request-a", ok: true, status: 200,
      format: "text", text: loginPage,
    });
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

  it("rejects a GitHub operation on the CNB main-world boundary before fetch", async () => {
    await expect(handleBridgeRequest(githubRequest, fetchMock)).resolves.toEqual({
      channel: "channel-a", requestId: "request-a", ok: false, status: 0, code: "compatibility",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("compares the active origin with the built URL under divergent proxy descriptors", async () => {
    const target = {
      platform: "github", type: "repository-page", repository: "acme/repo",
      ref: null, path: "", view: "root",
    };
    const operation = new Proxy(target, {
      get(current, key, receiver) { return key === "platform" ? "cnb" : Reflect.get(current, key, receiver); },
      getOwnPropertyDescriptor: Reflect.getOwnPropertyDescriptor,
    });
    await expect(handleBridgeRequest({ ...request, operation }, fetchMock)).resolves.toEqual({
      channel: "channel-a", requestId: "request-a", ok: false, status: 0, code: "compatibility",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects inherited request correlation fields", async () => {
    await expect(handleBridgeRequest(Object.create(request), fetchMock)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects accessor-backed request and operation fields without reading them", async () => {
    let reads = 0;
    const accessorRequest = Object.defineProperty({ requestId: "request-a", operation: request.operation }, "channel", {
      enumerable: true,
      get() { reads++; return "channel-a"; },
    });
    await expect(handleBridgeRequest(accessorRequest, fetchMock)).resolves.toBeNull();
    const accessorOperation = Object.defineProperty({ platform: "cnb", type: "get-head" }, "repository", {
      enumerable: true,
      get() { reads++; return "acme/repo"; },
    });
    await expect(handleBridgeRequest({ ...request, operation: accessorOperation }, fetchMock)).resolves.toEqual({
      channel: "channel-a", requestId: "request-a", ok: false, status: 0, code: "compatibility",
    });
    expect(reads).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects proxy-backed envelopes without leaking proxy failures", async () => {
    const descriptorProxy = new Proxy({}, {
      getOwnPropertyDescriptor() { throw new Error("private proxy failure"); },
    });
    await expect(handleBridgeRequest(descriptorProxy, fetchMock)).resolves.toBeNull();
    const ownKeysProxy = new Proxy({ ...request }, {
      ownKeys() { throw new Error("private proxy failure"); },
    });
    await expect(handleBridgeRequest(ownKeysProxy, fetchMock)).resolves.toEqual({
      channel: "channel-a", requestId: "request-a", ok: false, status: 0, code: "compatibility",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects revoked request and operation proxies without leaking or fetching", async () => {
    const revokedRequest = Proxy.revocable({ ...request }, {});
    revokedRequest.revoke();
    await expect(handleBridgeRequest(revokedRequest.proxy, fetchMock)).resolves.toBeNull();

    const revokedOperation = Proxy.revocable({ ...request.operation }, {});
    revokedOperation.revoke();
    await expect(handleBridgeRequest({ ...request, operation: revokedOperation.proxy }, fetchMock)).resolves.toEqual({
      channel: "channel-a", requestId: "request-a", ok: false, status: 0, code: "compatibility",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-enumerable, symbol, and inherited caller controls before fetch", async () => {
    const hiddenOperation = Object.defineProperty({ ...request.operation }, "method", { value: "POST" });
    const symbolOperation = { ...request.operation, [Symbol("caller-control")]: "POST" };
    const inheritedOperations = ["method", "url", "origin", "headers", "credentials", "redirect", "maximumBodyUnits"]
      .map((control) => Object.assign(Object.create({ [control]: "hostile" }), request.operation));
    for (const operation of [hiddenOperation, symbolOperation, ...inheritedOperations]) {
      await expect(handleBridgeRequest({ ...request, operation }, fetchMock)).resolves.toEqual({
        channel: "channel-a", requestId: "request-a", ok: false, status: 0, code: "compatibility",
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    undefined, null, [], {}, { platform: "cnb", type: "get-head", repository: 1 },
    { platform: "cnb", type: "fetch", url: "https://example.com", method: "POST" },
    { platform: "cnb", type: "get-head", repository: "acme/../repo" },
    { platform: "cnb", type: "get-head", repository: "acme/repo", url: "https://example.com" },
    { platform: "cnb", type: "get-head", repository: "acme/repo", method: "POST" },
    { platform: "cnb", type: "list-directory", repository: "acme/repo", ref: "main", path: 1 },
    { platform: "cnb", type: "list-directory", repository: "acme/repo", ref: "main", path: "../private" },
    { platform: "cnb", type: "list-directory", repository: "acme/repo", ref: "main?raw=1", path: "" },
    { platform: "cnb", type: "list-tags", repository: "acme/repo", page: "1", pageSize: 20 },
    { platform: "cnb", type: "list-branches", repository: "acme/repo", page: NaN, pageSize: 20 },
    { platform: "cnb", type: "list-tags", repository: "acme/repo", page: 1, pageSize: Infinity },
    { platform: "cnb", type: "get-head", repository: "acme/repo\ud800" },
    { platform: "github", type: "get-head", repository: "acme/repo" },
    { platform: "github", type: "repository-page", repository: "acme/repo", ref: null, path: "", view: "root", credentials: "omit" },
  ])("rejects malformed or disallowed operations %# without exposing input", async (operation) => {
    await expect(handleBridgeRequest({ ...request, operation }, fetchMock)).resolves.toEqual({
      channel: "channel-a", requestId: "request-a", ok: false, status: 0, code: "compatibility",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("main-world lifetime and event wiring", () => {
  it("responds only to the fixed window request event", async () => {
    fetchMock.mockResolvedValue(jsonResponse('{"name":"main"}'));
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
      channel: "channel-a", requestId: "request-a", ok: true, status: 200,
      format: "json", data: { name: "main" },
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

  it("does not install bridge or history hooks on an unsupported origin", async () => {
    const push = window.history.pushState;
    const replace = window.history.replaceState;
    const before = listeners.length;
    Reflect.deleteProperty(window, Symbol.for("repotreex.pageBridge"));
    const location = window.location;
    vi.stubGlobal("window", new Proxy(window, {
      get(target, key, receiver) {
        return key === "location" ? { origin: "https://example.com" } : Reflect.get(target, key, receiver);
      },
    }));
    vi.resetModules();
    await import("../src/page/bridge");
    expect(location.origin).toBe("https://cnb.cool");
    expect(history.pushState).toBe(push);
    expect(history.replaceState).toBe(replace);
    expect(listeners).toHaveLength(before);
    expect(Object.hasOwn(globalThis.window, Symbol.for("repotreex.pageBridge"))).toBe(false);
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
    fetchMock.mockResolvedValueOnce(jsonResponse('{"name":"main","sha":"abc"}'));
    const client = createBridgeClient(window, "round-trip", { timeoutMs: 1_000 });
    try {
      await expect(client.request({
        platform: "cnb", type: "get-head", repository: "acme/repo",
      })).resolves.toEqual({ name: "main", sha: "abc" });
      fetchMock.mockResolvedValueOnce(responseAt("cnb", "private", { status: 401 }));
      await expect(client.request({
        platform: "cnb", type: "get-head", repository: "acme/repo",
      })).rejects.toMatchObject({ code: "signed-out", status: 401 });
    } finally {
      client.dispose();
    }
  });
});
