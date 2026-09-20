import { describe, expect, test } from "bun:test";
import { transformWithEsbuild } from "vite";
import viteConfig from "../vite.config.js";

describe("vendored React components", () => {
  test("use the automatic JSX runtime without a module-scoped React default", async () => {
    const source = `
      import { useState } from "react";
      export function SettingsEditor() {
        const [open] = useState(true);
        return open ? <section>Settings</section> : null;
      }
    `;

    const transformed = await transformWithEsbuild(
      source,
      "settings-editor.tsx",
      viteConfig.esbuild,
    );

    expect(transformed.code).toContain("react/jsx-runtime");
    expect(transformed.code).not.toContain("React.createElement");
  });
});
