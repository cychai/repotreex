// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://cnb.cool/"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeClient } from "../src/content/bridge-client";
import { RepositoryError } from "../src/shared/errors";
import type { BridgeRequest } from "../src/shared/protocol";

describe("bridge client", () => {
  const clients: ReturnType<typeof createBridgeClient>[] = [];
  const requests: BridgeRequest[] = [];
  const collectRequest = (event: Event) => {
    if (event instanceof CustomEvent) requests.push(event.detail);
  };
  const respond = (detail: unknown) => {
    window.dispatchEvent(new CustomEvent("repotreex:response", { detail }));
  };
  const createClient = (channel = "channel-a", timeoutMs = 1_000) => {
    const client = createBridgeClient(window, channel, { timeoutMs });
    clients.push(client);
    return client;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    requests.length = 0;
    window.addEventListener("repotreex:request", collectRequest);
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.dispose();
    window.removeEventListener("repotreex:request", collectRequest);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("correlates concurrent responses out of order using random UUIDs", async () => {
    const uuid = vi.spyOn(window.crypto, "randomUUID");
    const client = createClient();
    const first = client.request<{ name: string }>({ type: "get-head", repo: "acme/repo" });
    const second = client.request<string[]>({
      type: "list-tags", repo: "acme/repo", page: 1, pageSize: 20,
    });

    expect(uuid).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({
      channel: "channel-a", requestId: expect.any(String),
      operation: { type: "get-head", repo: "acme/repo" },
    });
    expect(requests[0].requestId).not.toBe(requests[1].requestId);
    respond({ ...requests[1], operation: undefined }); // Malformed, not a response.
    respond({ channel: "channel-a", requestId: requests[1].requestId, ok: true, status: 200, data: ["v1"] });
    respond({ channel: "channel-a", requestId: requests[0].requestId, ok: true, status: 200, data: { name: "main" } });
    await expect(second).resolves.toEqual(["v1"]);
    await expect(first).resolves.toEqual({ name: "main" });
  });

  it("ignores a different channel even when the request ID matches", async () => {
    const client = createClient("channel-a", 20);
    const pending = client.request({ type: "get-head", repo: "acme/repo" });
    const rejection = expect(pending).rejects.toMatchObject({ code: "network" });
    respond({ channel: "channel-b", requestId: requests[0].requestId, ok: true, status: 200, data: {} });
    await vi.advanceTimersByTimeAsync(20);
    await rejection;
  });

  it("ignores unknown IDs and duplicate or late responses", async () => {
    const client = createClient();
    const first = client.request({ type: "get-head", repo: "acme/repo" });
    respond({ channel: "channel-a", requestId: "unknown", ok: true, status: 200, data: "wrong" });
    const response = { channel: "channel-a", requestId: requests[0].requestId, ok: true, status: 200, data: "first" };
    respond(response);
    await expect(first).resolves.toBe("first");
    const second = client.request({ type: "get-head", repo: "acme/repo" });
    respond(response);
    respond({ ...response, requestId: requests[1].requestId, data: "second" });
    await expect(second).resolves.toBe("second");
  });

  it.each([
    null, [], {},
    { ok: "true", status: 200, data: {} },
    { ok: true, status: "200", data: {} },
    { ok: true, status: 401, data: {} },
    { ok: true, status: 200.5, data: {} },
    { ok: true, status: 200 },
    { ok: false, status: 401, code: "unknown" },
    { ok: false, status: -1, code: "network" },
    { ok: false, status: 600, code: "network" },
    { ok: false, status: 401, code: "signed-out", data: "private body" },
  ])("ignores malformed response %# before settling", async (fields) => {
    const client = createClient();
    const pending = client.request({ type: "get-head", repo: "acme/repo" });
    const envelope = { channel: "channel-a", requestId: requests[0].requestId };
    respond(fields && !Array.isArray(fields) ? { ...envelope, ...fields } : fields);
    respond({ ...envelope, ok: true, status: 200, data: "valid" });
    await expect(pending).resolves.toBe("valid");
  });

  it.each([
    [401, "signed-out"], [403, "forbidden"], [404, "not-found"],
    [429, "rate-limited"], [503, "server"], [0, "network"],
    [200, "compatibility"], [0, "cancelled"],
  ] as const)("turns %s/%s into a metadata-limited RepositoryError", async (status, code) => {
    const client = createClient();
    const pending = client.request({ type: "get-head", repo: "acme/repo" });
    respond({ channel: "channel-a", requestId: requests[0].requestId, ok: false, status, code });
    await expect(pending).rejects.toBeInstanceOf(RepositoryError);
    await expect(pending).rejects.toMatchObject({ code, status, message: code });
  });

  it("handles a synchronous response because pending work is registered before dispatch", async () => {
    const listener = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const request: BridgeRequest = event.detail;
      respond({ channel: request.channel, requestId: request.requestId, ok: true, status: 200, data: null });
    };
    window.addEventListener("repotreex:request", listener, { once: true });
    await expect(createClient().request({ type: "get-head", repo: "acme/repo" })).resolves.toBeNull();
  });

  it("cancels a pre-aborted request without dispatching", async () => {
    const controller = new AbortController();
    controller.abort("private reason");
    await expect(createClient().request({ type: "get-head", repo: "acme/repo" }, { signal: controller.signal }))
      .rejects.toMatchObject({ code: "cancelled", message: "cancelled" });
    expect(requests).toHaveLength(0);
  });

  it("cancels only the aborted request and removes its abort listener", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const client = createClient();
    const cancelled = client.request({ type: "get-head", repo: "acme/repo" }, { signal: controller.signal });
    const other = client.request({ type: "get-head", repo: "acme/repo" });
    const rejection = expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
    controller.abort("private reason");
    await rejection;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    respond({ channel: "channel-a", requestId: requests[0].requestId, ok: true, status: 200, data: "late" });
    respond({ channel: "channel-a", requestId: requests[1].requestId, ok: true, status: 200, data: "other" });
    await expect(other).resolves.toBe("other");
  });

  it("cleans abort listeners on success and timeout", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const client = createClient("channel-a", 20);
    const success = client.request({ type: "get-head", repo: "acme/repo" }, { signal: controller.signal });
    respond({ channel: "channel-a", requestId: requests[0].requestId, ok: true, status: 200, data: {} });
    await success;
    const timeout = client.request({ type: "get-head", repo: "acme/repo" }, { signal: controller.signal });
    const rejection = expect(timeout).rejects.toMatchObject({ code: "network" });
    await vi.advanceTimersByTimeAsync(20);
    await rejection;
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("uses a bounded default timeout without leaking timers", async () => {
    const client = createBridgeClient(window, "channel-a");
    clients.push(client);
    const pending = client.request({ type: "get-head", repo: "acme/repo" });
    const rejection = expect(pending).rejects.toMatchObject({ code: "network" });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
  });

  it("keeps clients on different channels independent", async () => {
    const firstClient = createClient("first");
    const secondClient = createClient("second");
    const first = firstClient.request({ type: "get-head", repo: "acme/repo" });
    const second = secondClient.request({ type: "get-head", repo: "acme/repo" });
    const rejection = expect(first).rejects.toMatchObject({ code: "cancelled" });
    firstClient.dispose();
    await rejection;
    respond({ channel: "second", requestId: requests[1].requestId, ok: true, status: 200, data: "second" });
    await expect(second).resolves.toBe("second");
  });

  it("rejects every pending request on idempotent disposal and prevents reuse", async () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const controller = new AbortController();
    const client = createClient();
    const first = client.request({ type: "get-head", repo: "acme/repo" }, { signal: controller.signal });
    const second = client.request({ type: "get-head", repo: "acme/repo" });
    const firstRejection = expect(first).rejects.toMatchObject({ code: "cancelled" });
    const secondRejection = expect(second).rejects.toMatchObject({ code: "cancelled" });
    client.dispose();
    client.dispose();
    await firstRejection;
    await secondRejection;
    expect(remove.mock.calls.filter(([type]) => type === "repotreex:response")).toHaveLength(1);
    await expect(client.request({ type: "get-head", repo: "acme/repo" })).rejects.toMatchObject({ code: "cancelled" });
    expect(requests).toHaveLength(2);
  });
});
