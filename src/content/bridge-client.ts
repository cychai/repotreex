import { RepositoryError, type RepositoryErrorCode } from "../shared/errors";
import {
  BRIDGE_REQUEST_EVENT,
  BRIDGE_RESPONSE_EVENT,
  type BridgeOperation,
  type BridgeRequest,
  type BridgeResponse,
} from "../shared/protocol";

export type BridgeClient = {
  request<T>(operation: BridgeOperation, options?: { signal?: AbortSignal }): Promise<T>;
  dispose(): void;
};

type PendingRequest = {
  resolve(data: unknown): void;
  reject(error: RepositoryError): void;
  cleanup(): void;
};

type ValidBridgeResponse =
  | Extract<BridgeResponse, { ok: true }>
  | (Extract<BridgeResponse, { ok: false }> & { code: RepositoryErrorCode });

const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ownKeys = Reflect.ownKeys;

function isErrorCode(value: unknown): value is RepositoryErrorCode {
  switch (value) {
    case "signed-out":
    case "forbidden":
    case "not-found":
    case "rate-limited":
    case "server":
    case "network":
    case "compatibility":
    case "cancelled":
      return true;
    default:
      return false;
  }
}

function snapshotResponse(value: unknown): ValidBridgeResponse | null {
  let keys: (string | symbol)[];
  const fields = new Map<string, unknown>();
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    keys = ownKeys(value);
    for (const key of keys) {
      if (typeof key !== "string") return null;
      const descriptor = getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return null;
      fields.set(key, descriptor.value);
    }
  } catch {
    return null;
  }
  const channel = fields.get("channel");
  const requestId = fields.get("requestId");
  const status = fields.get("status");
  const ok = fields.get("ok");
  if (typeof channel !== "string" || typeof requestId !== "string" ||
    typeof status !== "number" || !Number.isInteger(status)) return null;
  const expectedKeys = ok === true
    ? ["channel", "requestId", "ok", "status", "data"]
    : ["channel", "requestId", "ok", "status", "code"];
  if (keys.length !== expectedKeys.length || !expectedKeys.every((key) => fields.has(key))) return null;
  if (ok === true && status >= 200 && status <= 299) {
    return { channel, requestId, ok, status, data: fields.get("data") };
  }
  const code = fields.get("code");
  return ok === false && status >= 0 && status <= 599 && isErrorCode(code)
    ? { channel, requestId, ok, status, code }
    : null;
}

export function createBridgeClient(
  targetWindow: Window,
  channel: string,
  { timeoutMs = 15_000 }: { timeoutMs?: number } = {},
): BridgeClient {
  const pending = new Map<string, PendingRequest>();
  let disposed = false;

  const takePending = (requestId: string) => {
    const entry = pending.get(requestId);
    if (entry) {
      pending.delete(requestId);
      entry.cleanup();
    }
    return entry;
  };
  const onResponse = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const response = snapshotResponse(event.detail);
    if (response === null) return;
    if (response.channel !== channel) return;
    const entry = takePending(response.requestId);
    if (!entry) return;
    if (response.ok) entry.resolve(response.data);
    else entry.reject(new RepositoryError(response.code, { status: response.status }));
  };
  targetWindow.addEventListener(BRIDGE_RESPONSE_EVENT, onResponse);

  return {
    request<T>(operation: BridgeOperation, { signal }: { signal?: AbortSignal } = {}): Promise<T> {
      if (disposed || signal?.aborted) return Promise.reject(new RepositoryError("cancelled"));
      const requestId = targetWindow.crypto.randomUUID();
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => takePending(requestId)?.reject(new RepositoryError("cancelled"));
        const timer = targetWindow.setTimeout(() => {
          takePending(requestId)?.reject(new RepositoryError("network"));
        }, timeoutMs);
        pending.set(requestId, {
          // The caller selects the repository DTO; the bridge validates the envelope, not DTO semantics.
          resolve: (data) => resolve(data as T),
          reject,
          cleanup: () => {
            targetWindow.clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
          },
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        const request: BridgeRequest = { channel, requestId, operation };
        targetWindow.dispatchEvent(new CustomEvent(BRIDGE_REQUEST_EVENT, { detail: request }));
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      targetWindow.removeEventListener(BRIDGE_RESPONSE_EVENT, onResponse);
      for (const requestId of pending.keys()) {
        takePending(requestId)?.reject(new RepositoryError("cancelled"));
      }
    },
  };
}
