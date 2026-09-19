import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const vendor = (...parts) => resolve(here, "src", "vendor", "input-bindings", ...parts);

export default defineConfig({
  base: "/arpg/",
  // input-bindings-react is authored and packaged with TypeScript's react-jsx runtime.
  // Its source is vendored deliberately, so preserve that upstream compilation contract.
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  resolve: {
    alias: [
      {
        find: "@moritzbrantner/input-bindings-react/styles.css",
        replacement: vendor("packages", "input-bindings-react", "src", "styles.css"),
      },
      {
        find: "@moritzbrantner/input-bindings-react",
        replacement: vendor("packages", "input-bindings-react", "src", "index.tsx"),
      },
      {
        find: "@moritzbrantner/input-bindings-runtime",
        replacement: vendor("packages", "input-bindings-runtime", "src", "index.ts"),
      },
      {
        find: "@moritzbrantner/input-bindings-web",
        replacement: vendor("packages", "input-bindings-web", "src", "index.ts"),
      },
      {
        find: "@moritzbrantner/input-bindings",
        replacement: vendor("packages", "input-bindings", "src", "public.ts"),
      },
    ],
  },
});
