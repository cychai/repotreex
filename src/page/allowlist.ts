import { buildCnbAllowedRequest } from "../platforms/cnb/requests";
import { buildGitHubAllowedRequest } from "../platforms/github/requests";
import { FORBIDDEN_BRIDGE_CONTROLS, type BridgeOperation } from "../shared/protocol";

export type AllowedRequest = {
  url: URL;
  accept: "json" | "html";
  maximumBodyUnits: number;
};

const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ownKeys = Reflect.ownKeys;

function ownPlatform(operation: unknown): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    if (typeof operation !== "object" || operation === null || Array.isArray(operation)) {
      throw new TypeError("Invalid bridge operation");
    }
    descriptor = getOwnPropertyDescriptor(operation, "platform");
  } catch {
    throw new TypeError("Invalid bridge operation");
  }
  if (!descriptor || !("value" in descriptor)) throw new TypeError("Invalid bridge operation");
  return descriptor.value;
}

function rejectCallerControls(operation: object): void {
  let keys: (string | symbol)[];
  try {
    keys = ownKeys(operation);
  } catch {
    throw new TypeError("Invalid bridge operation");
  }
  if (keys.some((key) => typeof key === "symbol")) throw new TypeError("Invalid bridge operation");
  for (const control of FORBIDDEN_BRIDGE_CONTROLS) {
    try {
      if (control in operation) throw new TypeError("Invalid bridge operation");
    } catch {
      throw new TypeError("Invalid bridge operation");
    }
  }
}

export function buildAllowedRequest(operation: BridgeOperation): AllowedRequest {
  rejectCallerControls(operation);
  switch (ownPlatform(operation)) {
    case "cnb":
      return buildCnbAllowedRequest(operation as Extract<BridgeOperation, { platform: "cnb" }>);
    case "github":
      return buildGitHubAllowedRequest(operation as Extract<BridgeOperation, { platform: "github" }>);
    default:
      throw new TypeError("Unsupported bridge platform");
  }
}
