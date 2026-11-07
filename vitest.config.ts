import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    environmentOptions: { jsdom: { url: "https://cnb.cool/" } },
    clearMocks: true,
    css: { include: [/panel\.css/] },
    include: ["tests/**/*.test.ts"],
  },
});
