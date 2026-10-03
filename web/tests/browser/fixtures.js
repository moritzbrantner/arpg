import { test as base, expect } from "@playwright/test";
import { createServer } from "vite";
import { createServer as createHttpServer } from "node:http";

export const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await use(page);
    expect(errors).toEqual([]);
  },
  appUrl: [
    async ({ browserName }, use, workerInfo) => {
      const http = createHttpServer();
      const server = await createServer({
        server: { middlewareMode: true, hmr: { server: http } },
        appType: "spa",
        cacheDir: `.cache/browser-tests/${browserName}-${workerInfo.workerIndex}`,
        optimizeDeps: {
          include: [
            "react",
            "react-dom",
            "react-dom/client",
            "react/jsx-runtime",
            "react/jsx-dev-runtime",
          ],
        },
      });
      http.on("request", server.middlewares);
      await new Promise((resolve, reject) => {
        http.once("error", reject);
        http.listen(0, "127.0.0.1", resolve);
      });
      try {
        await use(`http://127.0.0.1:${http.address().port}/arpg/`);
      } finally {
        http.closeAllConnections();
        await new Promise((resolve) => http.close(resolve));
        await server.close();
      }
    },
    { scope: "worker" },
  ],
});

export { expect };
