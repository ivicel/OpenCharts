import { expect, test } from "@playwright/test";

/**
 * End-to-end Bar Replay walkthrough.
 *
 * Everything the unit suites cannot reach: the chart click that picks a start
 * bar, the transport buttons, the follow toggle, the practice-account badge and
 * the exit path. Runs against whichever market source is reachable — the flow
 * is identical on exchange data and on the bundled offline fallback.
 */

test("bar replay: pick a start bar, step forward, exit", async ({ page }) => {
  await page.goto("/");

  // The terminal renders once the demo session, symbols and accounts settle.
  const replayButton = page.getByRole("button", { name: /^Replay$/ });
  await expect(replayButton).toBeVisible({ timeout: 45_000 });

  // The chart must have painted before a bar can be picked.
  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible({ timeout: 45_000 });

  await replayButton.click();

  // Entering replay asks for a starting bar and loads the frozen snapshot.
  await expect(page.getByText(/set the replay starting point/i)).toBeVisible();

  // Click the middle of the pane: that lands on a real bar.
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);

  // A start point was accepted: the transport reports a cursor position.
  const progress = page.getByTestId("replay-progress");
  await expect(progress).toBeVisible();
  const progressBefore = (await progress.textContent())?.trim() ?? "";
  expect(progressBefore).toMatch(/^\d+ \/ \d+$/);

  const [indexBefore, totalBefore] = progressBefore.split(" / ").map(Number);
  expect(indexBefore!).toBeGreaterThan(0);
  // The snapshot is deeper than a single screen, i.e. there really is a future.
  expect(totalBefore!).toBeGreaterThan(indexBefore!);

  // The practice account is in place for trades placed during replay.
  await expect(page.getByText("Practice")).toBeVisible();

  // Stepping forward reveals exactly one more bar.
  await page.getByTitle(/Step forward one bar/).click();
  await expect(progress).toHaveText(`${indexBefore! + 1} / ${totalBefore!}`);

  // Stepping back returns to where we were.
  await page.getByTitle(/Step back one bar/).click();
  await expect(progress).toHaveText(progressBefore);

  // Space toggles playback.
  await page.keyboard.press("Space");
  await expect(page.getByTitle(/Pause/)).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.getByTitle(/^Play/)).toBeVisible();

  // Re-picking returns to the click-a-bar state without losing the snapshot.
  await page.getByRole("button", { name: /Start point/ }).click();
  await expect(page.getByText(/set the replay starting point/i)).toBeVisible();

  // Exit restores the live chart and hides the transport.
  await page.getByTitle("Exit replay").click();
  await expect(page.getByTestId("replay-progress")).toBeHidden();
  await expect(page.getByText(/set the replay starting point/i)).toBeHidden();
});

test("bar replay: candles after the start point stay hidden", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /^Replay$/ })).toBeVisible({ timeout: 45_000 });

  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: /^Replay$/ }).click();
  await expect(page.getByText(/set the replay starting point/i)).toBeVisible();

  const box = (await canvas.boundingBox())!;
  // Click near the left edge: an early start leaves a long hidden future.
  await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.5);
  await expect(page.getByTestId("replay-progress")).toBeVisible();

  const progress = (await page.getByTestId("replay-progress").textContent())!.trim();
  const [cursor, total] = progress.split(" / ").map(Number);
  // The snapshot still holds every bar, but the cursor hides the rest: that
  // hidden future is the whole point of a replay.
  expect(cursor!).toBeGreaterThan(0);
  expect(total!).toBeGreaterThan(cursor!);
});
