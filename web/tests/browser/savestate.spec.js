import { expect, test } from "./fixtures.js";

const SAVE_KEY = "arpg-save-document-v1";

const hudStatus = (page) => page.getByRole("region", { name: "Player status" }).locator("p");

async function saveLocally(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "Save game", exact: true }).click();
  await expect(settings.getByText("Local save available")).toBeVisible();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await expect(hudStatus(page).first()).toContainText("Game saved locally");
}

test("a local save survives a reload and restores the world", async ({ page, appUrl }) => {
  await page.goto(appUrl);
  await page.getByRole("button", { name: "Enter World", exact: true }).click();
  await saveLocally(page);

  await page.reload();
  await page.getByRole("button", { name: "Load Saved Game", exact: true }).click();
  await expect(hudStatus(page).first()).toContainText("Loaded local save");
});

test("an imported save stays loaded when browser storage cannot keep it", async ({
  page,
  appUrl,
}) => {
  await page.goto(appUrl);
  await page.getByRole("button", { name: "Enter World", exact: true }).click();
  await saveLocally(page);
  const saveText = await page.evaluate((key) => localStorage.getItem(key), SAVE_KEY);
  expect(saveText).toContain('"format": "arpg-save"');

  await page.evaluate(() => localStorage.clear());
  await page.addInitScript((key) => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException("Quota exceeded", "QuotaExceededError");
      return setItem.call(this, name, value);
    };
  }, SAVE_KEY);
  await page.reload();

  await page.getByLabel("Save file").setInputFiles({
    name: "portable.json",
    mimeType: "application/json",
    buffer: Buffer.from(saveText),
  });
  const status = hudStatus(page).first();
  await expect(status).toContainText("Imported portable.json");
  await expect(status).toContainText("not kept as the local save");
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
});
