import { buildAllowedRequest } from "./allowlist";
import { classifyHttpError, type RepositoryErrorCode } from "../shared/errors";
import {
  BRIDGE_REQUEST_EVENT,
  BRIDGE_RESPONSE_EVENT,
  NAVIGATION_EVENT,
  type BridgeOperation,
  type BridgeResponse,
} from "../shared/protocol";

const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;

function isRecord(value: unknown): value is object {
  try {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  try {
    return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  } catch {
    return false;
  }
}

function ownData(value: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = getOwnPropertyDescriptor(value, key);
  } catch {
    return undefined;
  }
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function isOperation(value: unknown): value is BridgeOperation {
  if (!isRecord(value)) return false;
  const platform = ownData(value, "platform");
  const type = ownData(value, "type");
  const repository = ownData(value, "repository");
  if (typeof repository !== "string") return false;
  if (platform === "cnb") {
    switch (type) {
      case "get-head":
        return hasOnlyKeys(value, ["platform", "type", "repository"]);
      case "list-directory":
        return hasOnlyKeys(value, ["platform", "type", "repository", "ref", "path"]) &&
          typeof ownData(value, "ref") === "string" && typeof ownData(value, "path") === "string";
      case "list-branches":
      case "list-tags":
        return hasOnlyKeys(value, ["platform", "type", "repository", "page", "pageSize"]) &&
          typeof ownData(value, "page") === "number" && typeof ownData(value, "pageSize") === "number";
      default:
        return false;
    }
  }
  if (platform !== "github") return false;
  if (type === "repository-page") {
    const ref = ownData(value, "ref");
    const view = ownData(value, "view");
    return hasOnlyKeys(value, ["platform", "type", "repository", "ref", "path", "view"]) &&
      (typeof ref === "string" || ref === null) && typeof ownData(value, "path") === "string" &&
      (view === "root" || view === "tree" || view === "blob");
  }
  if (type !== "refs-page") return false;
  const kind = ownData(value, "kind");
  if (kind === "branches") {
    return hasOnlyKeys(value, ["platform", "type", "repository", "kind", "page"]) &&
      typeof ownData(value, "page") === "number";
  }
  const after = ownData(value, "after");
  return kind === "tags" &&
    hasOnlyKeys(value, ["platform", "type", "repository", "kind", "after"]) &&
    (typeof after === "string" || after === null);
}

function transportFailure(error: unknown): RepositoryErrorCode | null {
  if (error instanceof DOMException) {
    if (error.name === "AbortError") return "cancelled";
    if (error.name === "NetworkError") return "network";
  }
  return error instanceof TypeError ? "network" : null;
}

function expectedContentType(accept: "json" | "html"): string {
  return accept === "json" ? "application/json" : "text/html";
}

const oversizedBody = Symbol("oversizedBody");

async function readBoundedText(response: Response, maximumBodyUnits: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (text.length > maximumBodyUnits) throw oversizedBody;
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > maximumBodyUnits) {
        try {
          await reader.cancel();
        } catch (error) {
          const code = transportFailure(error);
          if (code === null) throw error;
        }
        throw oversizedBody;
      }
    }
    text += decoder.decode();
    if (text.length > maximumBodyUnits) throw oversizedBody;
    return text;
  } finally {
    reader.releaseLock();
  }
}

export async function handleBridgeRequest(
  request: unknown,
  fetchImpl: typeof fetch,
  activeOrigin = window.location.origin,
): Promise<BridgeResponse | null> {
  // Without valid correlation fields there is no safe recipient for an error.
  if (!isRecord(request)) return null;
  const channel = ownData(request, "channel");
  const requestId = ownData(request, "requestId");
  if (typeof channel !== "string" || channel.length === 0 ||
    typeof requestId !== "string" || requestId.length === 0) return null;
  const failure = (status: number, code: RepositoryErrorCode): BridgeResponse => ({
    channel, requestId, ok: false, status, code,
  });
  const operation = ownData(request, "operation");
  if (!hasOnlyKeys(request, ["channel", "requestId", "operation"]) || !isOperation(operation)) {
    return failure(0, "compatibility");
  }
  let allowedRequest: ReturnType<typeof buildAllowedRequest>;
  try {
    allowedRequest = buildAllowedRequest(operation);
  } catch (error) {
    if (error instanceof TypeError || error instanceof URIError) return failure(0, "compatibility");
    throw error;
  }
  if (activeOrigin !== allowedRequest.url.origin) return failure(0, "compatibility");

  let response: Response;
  try {
    response = await fetchImpl(allowedRequest.url.href, {
      method: "GET",
      credentials: "include",
      headers: { Accept: expectedContentType(allowedRequest.accept) },
      cache: "no-store",
      redirect: "follow",
    });
  } catch (error) {
    const code = transportFailure(error);
    if (code !== null) return failure(0, code);
    throw error;
  }
  if (!response.ok) return failure(response.status, classifyHttpError(response.status).code);
  let responseOrigin: string;
  try {
    responseOrigin = new URL(response.url).origin;
  } catch {
    return failure(response.status, "compatibility");
  }
  if (responseOrigin !== activeOrigin) return failure(response.status, "compatibility");
  if (response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !==
    expectedContentType(allowedRequest.accept)) return failure(response.status, "compatibility");

  let text: string;
  try {
    text = await readBoundedText(response, allowedRequest.maximumBodyUnits);
  } catch (error) {
    if (error === oversizedBody) return failure(response.status, "compatibility");
    const code = transportFailure(error);
    if (code !== null) return failure(response.status, code);
    throw error;
  }
  if (allowedRequest.accept === "html") {
    return { channel, requestId, ok: true, status: response.status, format: "text", text };
  }
  try {
    const data: unknown = JSON.parse(text);
    return { channel, requestId, ok: true, status: response.status, format: "json", data };
  } catch (error) {
    if (error instanceof SyntaxError) return failure(response.status, "compatibility");
    throw error;
  }
}

function installBridge(): void {
  const installed = Symbol.for("repotreex.pageBridge");
  const activeOrigin = window.location.origin;
  if ((activeOrigin !== "https://cnb.cool" && activeOrigin !== "https://github.com") ||
    Object.hasOwn(window, installed)) return;

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
    void handleBridgeRequest(event.detail, window.fetch.bind(window), activeOrigin).then((response) => {
      if (response !== null) window.dispatchEvent(new CustomEvent(BRIDGE_RESPONSE_EVENT, { detail: response }));
    });
  });
  window.addEventListener("popstate", emitNavigation);
  window.addEventListener("hashchange", emitNavigation);
  Object.defineProperty(window, installed, { value: true, configurable: true });
}

installBridge();
