import { expect, test } from '@playwright/test';

test('command palette runs commands through the patch path', async ({ page }) => {
  await page.goto('/?test=1');
  const firstCheckbox = page.locator('.layer-row input[type="checkbox"]').first();
  await expect(firstCheckbox).toBeChecked();

  // Open with the keyboard shortcut, filter, and run with Enter.
  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('palette');
  await expect(palette).toBeVisible();
  await page.getByTestId('palette-input').fill('hide countries');
  await page.keyboard.press('Enter');

  await expect(palette).toBeHidden();
  await expect(firstCheckbox).not.toBeChecked();

  // Escape closes without running anything.
  await page.getByTestId('open-palette').click();
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  await expect(firstCheckbox).not.toBeChecked();
});

test('theme toggle switches and persists', async ({ page }) => {
  await page.goto('/?test=1');
  const html = page.locator('html');
  const initial = await html.getAttribute('data-theme');
  const next = initial === 'dark' ? 'light' : 'dark';

  await page.getByTestId('toggle-theme').click();
  await expect(html).toHaveAttribute('data-theme', next);

  await page.reload();
  await expect(html).toHaveAttribute('data-theme', next);
});

test('layers with a color encoding show a legend', async ({ page }) => {
  await page.goto('/?test=1');
  await expect(page.getByTestId('legend-cities-points')).toContainText('pop');
});
