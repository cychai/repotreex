export const BRIDGE_REQUEST_EVENT = "repotreex:request";
export const BRIDGE_RESPONSE_EVENT = "repotreex:response";
export const NAVIGATION_EVENT = "repotreex:navigation";

export type BridgeOperation =
  | { type: "list-directory"; repo: string; ref: string; path: string }
  | { type: "get-head"; repo: string }
  | { type: "list-branches"; repo: string; page: number; pageSize: number }
  | { type: "list-tags"; repo: string; page: number; pageSize: number };

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
  sha: string;
};

export type Tag = {
  name: string;
  sha: string;
};

export type HeadRef = {
  name: string;
  sha: string;
};
