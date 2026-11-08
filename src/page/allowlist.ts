import { buildCnbAllowedRequest } from "../platforms/cnb/requests";
import { buildGitHubAllowedRequest } from "../platforms/github/requests";
import type { BridgeOperation } from "../shared/protocol";

export type AllowedRequest = {
  url: URL;
  accept: "json" | "html";
  maximumBodyUnits: number;
};

const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;

function ownPlatform(operation: unknown): unknown {
  if (typeof operation !== "object" || operation === null || Array.isArray(operation)) {
    throw new TypeError("Invalid bridge operation");
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = getOwnPropertyDescriptor(operation, "platform");
  } catch {
    throw new TypeError("Invalid bridge operation");
  }
  if (!descriptor || !("value" in descriptor)) throw new TypeError("Invalid bridge operation");
  return descriptor.value;
}

export function buildAllowedRequest(operation: BridgeOperation): AllowedRequest {
  switch (ownPlatform(operation)) {
    case "cnb":
      return buildCnbAllowedRequest(operation as Extract<BridgeOperation, { platform: "cnb" }>);
    case "github":
      return buildGitHubAllowedRequest(operation as Extract<BridgeOperation, { platform: "github" }>);
    default:
      throw new TypeError("Unsupported bridge platform");
  }
}
