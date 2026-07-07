import { expect, test } from '@playwright/test';

test('scrubbing the timeline updates the time cursor via a patch', async ({ page }) => {
  await page.goto('/?test=1');

  const label = page.getByTestId('timeline-label');
  await expect(label).toHaveText('all time');

  // Scrub to 2026-04-01 (a value inside the dataset's range).
  const cursor = Date.UTC(2026, 3, 1);
  const slider = page.getByTestId('timeline-slider');
  await slider.fill(String(cursor));

  await expect(label).toHaveText('2026-04-01');

  // Reset returns to the unfiltered ("all time") view.
  await page.getByTestId('timeline-all').click();
  await expect(label).toHaveText('all time');
});
