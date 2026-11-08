import type { RepositoryPlatformAdapter } from "../types";
import { cnbLayout } from "./layout";
import { createCnbProvider } from "./provider";
import {
  buildCnbFileUrl, buildCnbRefRootUrl, parseCnbRoute, reconcileCnbRoute,
} from "./route";

export const cnbAdapter: RepositoryPlatformAdapter = {
  id: "cnb",
  origin: "https://cnb.cool",
  layout: cnbLayout,
  parseRoute: parseCnbRoute,
  reconcileRoute: reconcileCnbRoute,
  buildFileUrl: buildCnbFileUrl,
  buildRefRootUrl: buildCnbRefRootUrl,
  createProvider: createCnbProvider,
};

export { cnbLayout } from "./layout";
export { createCnbProvider } from "./provider";
export {
  buildCnbFileUrl, buildCnbRefRootUrl, parseCnbRoute, reconcileCnbRoute,
} from "./route";
