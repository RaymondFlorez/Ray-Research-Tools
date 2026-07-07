import { expect, test } from '@playwright/test';

test('clicking a country selects it and opens the Inspector', async ({ page }) => {
  // test=1 disables auto-rotation so the globe holds still (Africa/Europe centered).
  await page.goto('/?test=1');

  const canvas = page.locator('.globe canvas').first();
  await expect(canvas).toBeVisible();
  // Let deck.gl initialize WebGL and load the countries GeoJSON.
  await page.waitForTimeout(2500);

  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Click at / around center until a feature is hit (center is over African landmass).
  const offsets = [
    [0, 0],
    [0, 30],
    [-30, 20],
    [30, 40],
    [0, -30],
  ];
  const inspector = page.getByTestId('inspector');
  for (const [dx, dy] of offsets) {
    await page.mouse.click(cx + dx, cy + dy);
    await page.waitForTimeout(400);
    if (await inspector.isVisible()) break;
  }

  await expect(inspector).toBeVisible();
  // The selected country exposes at least an id/name in the Inspector.
  await expect(page.getByTestId('inspector-id')).not.toBeEmpty();
});
