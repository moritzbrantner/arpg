import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.js";

for (const role of ["host", "guest"] as const) {
  test(`${role} co-op obtains participant-authorized temporary TURN credentials`, async ({
    page,
    appUrl,
  }) => {
    const origin = new URL(appUrl).origin;
    const participantToken = randomUUID();
    const credential = randomUUID();
    const lobbyId = "ABCDEFGHJKLM";
    const participantId = role === "host" ? "ABCDEFGH" : "JKLMNPQR";
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let credentialRequests = 0;
    await page.route(`${origin}/lobbies**`, async (route) => {
      const request = route.request();
      if (request.url().endsWith("/turn-credentials")) {
        expect(request.method()).toBe("POST");
        expect(request.headers().authorization).toBe(`Bearer ${participantToken}`);
        expect(request.postDataJSON()).toEqual({ participantId });
        credentialRequests += 1;
        await route.fulfill({
          json: {
            iceServers: [{ urls: "turn:127.0.0.1:3478", username: "test-participant", credential }],
            expiresAt: Date.now() + 600_000,
          },
        });
        return;
      }
      expect(request.method()).toBe("POST");
      await route.fulfill({
        json: {
          lobbyId,
          displayCode: "ABCD-EFGH-JKLM",
          participantId,
          participantToken,
          hostParticipantId: "ABCDEFGH",
          maxParticipants: 4,
          expiresAt: Date.now() + 600_000,
          maxExpiresAt: Date.now() + 3_600_000,
          websocketPath: `/lobbies/${lobbyId}/connect`,
        },
      });
    });
    await page.routeWebSocket(`${origin.replace("http:", "ws:")}/lobbies/**`, () => {});
    await page.goto(appUrl);
    await page.getByRole("button", { name: "Enter World", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Setup service URL").fill(origin);
    if (role === "host") {
      await page.getByRole("button", { name: "Host co-op", exact: true }).click();
    } else {
      await page.getByLabel("Lobby code").fill(lobbyId);
      await page.getByRole("button", { name: "Join host", exact: true }).click();
    }
    await expect.poll(() => credentialRequests).toBe(1);
    const stored = await page.evaluate(() => JSON.stringify(localStorage));
    expect(stored).not.toContain(participantToken);
    expect(stored).not.toContain(credential);
    expect(page.url()).not.toContain(participantToken);
    expect(errors).toEqual([]);
  });
}
