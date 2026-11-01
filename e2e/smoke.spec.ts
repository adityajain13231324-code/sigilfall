import { test, expect, Page } from '@playwright/test';

async function drawTriangle(page: Page) {
  const m = await page.evaluate(() => {
    const p = (window as any).__sigil.scene.plane;
    return { cx: p.cx, cy: p.cy, r: p.rPx };
  });
  const c = [[m.cx, m.cy - m.r * 0.6], [m.cx + m.r * 0.55, m.cy + m.r * 0.45], [m.cx - m.r * 0.55, m.cy + m.r * 0.45], [m.cx, m.cy - m.r * 0.6]];
  await page.mouse.move(c[0]![0]!, c[0]![1]!);
  await page.mouse.down();
  for (let i = 0; i < 3; i++) {
    for (let k = 1; k <= 12; k++) {
      await page.mouse.move(c[i]![0]! + (c[i + 1]![0]! - c[i]![0]!) * (k / 12), c[i]![1]! + (c[i + 1]![1]! - c[i]![1]!) * (k / 12));
      await page.waitForTimeout(12);
    }
  }
  await page.mouse.up();
}

test('boots, opens the Practice Sanctum, then completes a duel round against the Apprentice', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'SIGILFALL' })).toBeVisible();

  // practice: open a lesson and complete it
  await page.getByRole('button', { name: 'Practice Sanctum' }).click();
  await expect(page.getByRole('heading', { name: 'Practice Sanctum' })).toBeVisible();
  await page.getByRole('button', { name: 'Guided lessons' }).click();
  await page.getByRole('button', { name: /Cinder Bolt/ }).click();
  for (let i = 0; i < 3; i++) {
    await drawTriangle(page);
    await page.waitForTimeout(250);
  }
  await expect(page.locator('.lesson')).toContainText('Lesson complete');

  // duel vs Apprentice
  await page.evaluate(() => (window as any).__sigil.menu());
  await page.getByRole('button', { name: 'Duel the Magister' }).click();
  await page.getByRole('heading', { name: 'Apprentice' }).click();
  await page.getByRole('heading', { name: 'Oath of Embers' }).click();
  await expect(page.locator('#hud')).toBeVisible();
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const s = (window as any).__sigil.scene.driver.state;
    s.w[1].vit = 1; // one hit from defeat so the round ends quickly
  });
  const result = page.getByText(/ROUND WON|ROUND LOST|VICTORY|DEFEAT|DRAW/);
  for (let i = 0; i < 8 && !(await result.isVisible()); i++) {
    await drawTriangle(page); // keep casting; the Apprentice may dodge or ward a few
    await page.waitForTimeout(2200);
  }
  await expect(result).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});
