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

function isResponse(value: unknown): value is ValidBridgeResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (!("channel" in value) || typeof value.channel !== "string" ||
    !("requestId" in value) || typeof value.requestId !== "string" ||
    !("status" in value) || typeof value.status !== "number" || !Number.isInteger(value.status) ||
    !("ok" in value)) return false;
  const keys = value.ok === true
    ? ["channel", "requestId", "ok", "status", "data"]
    : ["channel", "requestId", "ok", "status", "code"];
  if (Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) return false;
  return value.ok === true
    ? value.status >= 200 && value.status <= 299
    : value.ok === false && value.status >= 0 && value.status <= 599 &&
      "code" in value && isErrorCode(value.code);
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
    if (!(event instanceof CustomEvent) || !isResponse(event.detail)) return;
    const response = event.detail;
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
