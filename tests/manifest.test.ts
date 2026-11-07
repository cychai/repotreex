import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.json";

describe("extension manifest", () => {
  it("uses only the required CNB host and storage permission", () => {
    expect(manifest.host_permissions).toEqual(["https://cnb.cool/*"]);
    expect(manifest.permissions).toEqual(["storage"]);
    expect(manifest.permissions).not.toContain("cookies");
    expect(manifest.permissions).not.toContain("webRequest");
  });

  it("loads isolated UI before the main-world bridge", () => {
    expect(manifest.content_scripts).toEqual([
      expect.objectContaining({
        matches: ["https://cnb.cool/*"],
        js: ["content/index.js"],
        run_at: "document_start",
      }),
      expect.objectContaining({
        matches: ["https://cnb.cool/*"],
        js: ["page/bridge.js"],
        world: "MAIN",
        run_at: "document_start",
      }),
    ]);
  });
});
