import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    clearMocks: true,
    css: { include: [/panel\.css/] },
    include: ["tests/**/*.test.ts"],
  },
});
