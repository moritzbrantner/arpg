import { readFile } from "node:fs/promises";

import { expect, test } from "./fixtures.js";

const point = (id, x, y) => ({ id, x: Math.round(x), y: Math.round(y) });
const center = (id, rect) => point(id, rect.x + rect.width / 2, rect.y + rect.height / 2);

async function touch(cdp, type, ...touchPoints) {
  // Chromium's CDP exercises non-primary contacts, unlike Playwright's tap().
  await cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
}

async function exportedCommands(page) {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export reproduction", exact: true }).click();
  const file = await download;
  const replay = JSON.parse(await readFile(await file.path(), "utf8"));
  return replay.commands.map((entry) => entry.command);
}

async function phone(browser, appUrl) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await page.goto(`${appUrl}?scenario=training&seed=42`);
  await page.getByRole("button", { name: "Pause", exact: true }).tap();
  return { context, page, cdp: await context.newCDPSession(page) };
}

test("two fingers move, attack once, and continue moving independently", async ({
  browser,
  appUrl,
}) => {
  const { context, page, cdp } = await phone(browser, appUrl);
  try {
    const stickRect = await page.getByRole("group", { name: "Movement joystick" }).boundingBox();
    const attack = page.getByRole("button", { name: "Primary attack", exact: true });
    const attackRect = await attack.boundingBox();
    const origin = center(1, stickRect);
    const right = point(1, origin.x + stickRect.width * 0.4, origin.y);
    const forward = point(1, origin.x, origin.y - stickRect.height * 0.4);
    const strike = center(2, attackRect);
    const targets = await page.evaluate(
      (points) =>
        points.map(({ x, y }) => {
          const hit = document.elementFromPoint(x, y);
          const target = hit?.closest("button, [aria-label='Movement joystick']");
          return target?.getAttribute("aria-label");
        }),
      [origin, strike],
    );
    expect(targets).toEqual(["Movement joystick", "Primary attack"]);

    await touch(cdp, "touchStart", origin);
    await touch(cdp, "touchMove", right);
    await touch(cdp, "touchStart", right, strike);
    await touch(cdp, "touchEnd", strike);
    await touch(cdp, "touchMove", forward);
    await touch(cdp, "touchEnd", forward);

    await page.getByRole("button", { name: "Step", exact: true }).click();

    const commands = (await exportedCommands(page))
      .filter((command) => command.type === "setMovement" || command.type === "primaryAttack")
      .map((command) =>
        command.type === "setMovement" ? `${command.x},${command.z}` : "primaryAttack",
      );
    expect(commands).toEqual(["1,0", "primaryAttack", "0,-1", "0,0"]);
    await expect(attack).toHaveAttribute("data-phase", "windup");
  } finally {
    await context.close();
  }
});

test("a single touch press does not double-dispatch its synthesized click", async ({
  browser,
  appUrl,
}) => {
  const { context, page } = await phone(browser, appUrl);
  try {
    await page.getByRole("button", { name: "Primary attack", exact: true }).tap();
    await page.getByRole("button", { name: "Step", exact: true }).click();
    const commands = await exportedCommands(page);
    expect(commands.filter((command) => command.type === "primaryAttack")).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("a mouse click after a touch still triggers a separate action", async ({
  browser,
  appUrl,
}) => {
  const { context, page } = await phone(browser, appUrl);
  try {
    const attack = page.getByRole("button", { name: "Primary attack", exact: true });
    await attack.tap();
    await attack.click();
    await page.getByRole("button", { name: "Step", exact: true }).click();
    const commands = await exportedCommands(page);
    expect(commands.filter((command) => command.type === "primaryAttack")).toHaveLength(2);
  } finally {
    await context.close();
  }
});

test("holding guard while moving releases only when the guard finger lifts", async ({
  browser,
  appUrl,
}) => {
  const { context, page, cdp } = await phone(browser, appUrl);
  try {
    const guardRect = await page.getByRole("button", { name: "Hold shield" }).boundingBox();
    const stickRect = await page.getByRole("group", { name: "Movement joystick" }).boundingBox();
    const guard = center(1, guardRect);
    const origin = center(2, stickRect);
    const moving = point(2, origin.x + stickRect.width * 0.4, origin.y);

    await touch(cdp, "touchStart", guard);
    await touch(cdp, "touchStart", guard, origin);
    await touch(cdp, "touchMove", guard, moving);
    await touch(cdp, "touchEnd", moving);
    await page.getByRole("button", { name: "Step", exact: true }).click();
    // The second finger's release must not lower the first finger's shield.
    const held = await exportedCommands(page);
    expect(held.filter((command) => command.type === "setGuard")).toEqual([
      { type: "setGuard", raised: true },
    ]);
    await touch(cdp, "touchEnd", guard);
    await page.getByRole("button", { name: "Step", exact: true }).click();

    const commands = await exportedCommands(page);
    expect(commands.filter((command) => command.type === "setGuard")).toEqual([
      { type: "setGuard", raised: true },
      { type: "setGuard", raised: false },
    ]);
    expect(commands.filter((command) => command.type === "setMovement")).toEqual([
      { type: "setMovement", x: 1, z: 0 },
      { type: "setMovement", x: 0, z: 0 },
    ]);
  } finally {
    await context.close();
  }
});
