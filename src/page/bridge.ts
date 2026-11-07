import { buildAllowedRequest } from "./allowlist";
import { classifyHttpError, type RepositoryErrorCode } from "../shared/errors";
import {
  BRIDGE_REQUEST_EVENT,
  BRIDGE_RESPONSE_EVENT,
  NAVIGATION_EVENT,
  type BridgeOperation,
  type BridgeResponse,
} from "../shared/protocol";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isOperation(value: unknown): value is BridgeOperation {
  if (!isRecord(value) || typeof value.repo !== "string") return false;
  switch (value.type) {
    case "get-head":
      return hasOnlyKeys(value, ["type", "repo"]);
    case "list-directory":
      return hasOnlyKeys(value, ["type", "repo", "ref", "path"]) &&
        typeof value.ref === "string" && typeof value.path === "string";
    case "list-branches":
    case "list-tags":
      return hasOnlyKeys(value, ["type", "repo", "page", "pageSize"]) &&
        typeof value.page === "number" && typeof value.pageSize === "number";
    default:
      return false;
  }
}

function transportFailure(error: unknown): RepositoryErrorCode | null {
  if (error instanceof DOMException) {
    if (error.name === "AbortError") return "cancelled";
    if (error.name === "NetworkError") return "network";
  }
  return error instanceof TypeError ? "network" : null;
}

export async function handleBridgeRequest(
  request: unknown,
  fetchImpl: typeof fetch,
): Promise<BridgeResponse | null> {
  // Without valid correlation fields there is no safe recipient for an error.
  if (!isRecord(request) ||
    !Object.hasOwn(request, "channel") || typeof request.channel !== "string" || request.channel.length === 0 ||
    !Object.hasOwn(request, "requestId") || typeof request.requestId !== "string" || request.requestId.length === 0) {
    return null;
  }
  const { channel, requestId } = request;
  const failure = (status: number, code: RepositoryErrorCode): BridgeResponse => ({
    channel, requestId, ok: false, status, code,
  });
  if (!hasOnlyKeys(request, ["channel", "requestId", "operation"]) || !isOperation(request.operation)) {
    return failure(0, "compatibility");
  }

  let url: URL;
  try {
    url = buildAllowedRequest(request.operation);
  } catch (error) {
    if (error instanceof TypeError || error instanceof URIError) return failure(0, "compatibility");
    throw error;
  }

  let response: Response;
  try {
    response = await fetchImpl(url.href, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
  } catch (error) {
    const code = transportFailure(error);
    if (code !== null) return failure(0, code);
    throw error;
  }
  if (!response.ok) return failure(response.status, classifyHttpError(response.status).code);

  try {
    const data: unknown = await response.json();
    return { channel, requestId, ok: true, status: response.status, data };
  } catch (error) {
    if (error instanceof SyntaxError) return failure(response.status, "compatibility");
    const code = transportFailure(error);
    if (code !== null) return failure(response.status, code);
    throw error;
  }
}

function installBridge(): void {
  const installed = Symbol.for("repotreex.pageBridge");
  if (window.location.origin !== "https://cnb.cool" || Object.hasOwn(window, installed)) return;

  const emitNavigation = () => window.dispatchEvent(new CustomEvent(NAVIGATION_EVENT));
  for (const method of ["pushState", "replaceState"] as const) {
    // Replace the descriptor where it lives; do not shadow native prototype methods.
    let owner: object | null = window.history;
    while (owner !== null && !Object.hasOwn(owner, method)) {
      owner = Object.getPrototypeOf(owner);
    }
    if (owner === null) throw new TypeError("Missing history method");
    const descriptor = Object.getOwnPropertyDescriptor(owner, method);
    if (!descriptor || typeof descriptor.value !== "function") throw new TypeError("Invalid history method");
    const original: History[typeof method] = descriptor.value;
    Object.defineProperty(owner, method, {
      ...descriptor,
      value: function (this: History, ...args: Parameters<History[typeof method]>) {
        const result: unknown = Reflect.apply(original, this, args);
        emitNavigation();
        return result;
      },
    });
  }

  window.addEventListener(BRIDGE_REQUEST_EVENT, (event) => {
    if (!(event instanceof CustomEvent)) return;
    void handleBridgeRequest(event.detail, window.fetch.bind(window)).then((response) => {
      if (response !== null) window.dispatchEvent(new CustomEvent(BRIDGE_RESPONSE_EVENT, { detail: response }));
    });
  });
  window.addEventListener("popstate", emitNavigation);
  window.addEventListener("hashchange", emitNavigation);
  Object.defineProperty(window, installed, { value: true, configurable: true });
}

installBridge();
