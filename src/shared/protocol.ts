export const BRIDGE_REQUEST_EVENT = "repotreex:request";
export const BRIDGE_RESPONSE_EVENT = "repotreex:response";
export const NAVIGATION_EVENT = "repotreex:navigation";
export const FORBIDDEN_BRIDGE_CONTROLS = [
  "method", "url", "origin", "headers", "credentials", "redirect", "maximumBodyUnits",
] as const;

export type CnbBridgeOperation =
  | { platform: "cnb"; type: "list-directory"; repository: string; ref: string; path: string }
  | { platform: "cnb"; type: "get-head"; repository: string }
  | {
    platform: "cnb";
    type: "list-branches" | "list-tags";
    repository: string;
    page: number;
    pageSize: number;
  };

export type GitHubBridgeOperation =
  | {
    platform: "github";
    type: "repository-page";
    repository: string;
    ref: string | null;
    path: string;
    view: "root" | "tree" | "blob";
  }
  | {
    platform: "github";
    type: "refs-page";
    repository: string;
    kind: "branches" | "tags";
    page: number;
  };

export type BridgeOperation = CnbBridgeOperation | GitHubBridgeOperation;

export type BridgeRequest = {
  channel: string;
  requestId: string;
  operation: BridgeOperation;
};

export type BridgeResponse =
  | { channel: string; requestId: string; ok: true; status: number; data: unknown }
  | { channel: string; requestId: string; ok: false; status: number; code: string };

export type TreeEntryType = "tree" | "blob" | "link" | "submodule";

export type TreeEntry = {
  type: TreeEntryType;
  path: string;
  name: string;
  sha: string;
  size?: number;
};

export type TreeContent = {
  type: "tree";
  path: string;
  name: string;
  sha: string;
  size: number;
  entries: TreeEntry[];
};

export type BlobContent = {
  type: "blob";
  path: string;
  name: string;
  sha: string;
  size: number;
  content: string;
  encoding: string;
};

export type Content = TreeContent | BlobContent;

export type Branch = {
  name: string;
  commit: { sha: string };
};

export type Tag = {
  name: string;
  commit: { sha: string };
};

export type HeadRef = {
  name: string;
};
