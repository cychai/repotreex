import type { HostLayoutAdapter } from "../types";

// Panel layout ownership remains in content/panel.ts until the layout migration.
export const cnbLayout: HostLayoutAdapter = {
  platform: "cnb",
  install() {
    return { update() {}, destroy() {} };
  },
};
