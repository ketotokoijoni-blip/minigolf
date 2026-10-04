// (b) Single player through the real UI: #/play -> Perusradat -> Aloita -> title card -> keyboard shots (Space =
// default aim toward the hole, §12.3) -> HUD stroke counter -> hole summary -> Jatka -> round summary; plus a mouse
// shot computed from the start tile through the canvas bounding box, the Tab scorecard and the Esc pause menu.
import { expect, test } from '@playwright/test';
import {
  FI, expectCleanConsole, expectNoRawKeys, gameCanvasBox, hudStat, hudTurn, playHoleWithKeyboard,
  shot, startSinglePlayer, tileToScreen, waitForTurnOrSummary, watchConsole,
} from './helpers/app';

test.describe('single player', () => {
  test('one-course round with keyboard shots: title card, HUD, hole summary, round summary', async ({ page }) => {
    test.setTimeout(240_000);
    const log = watchConsole(page);

    // ---- #/play setup
    await page.goto('/#/play');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Yksinpeli');
    await expect(page.getByRole('tab', { name: 'Perusradat' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.list-item--course')).toHaveCount(9);
    await expect(page.getByRole('button', { name: 'Aloita', exact: true })).toBeDisabled();
    await page.locator('.list-item--course').filter({ hasText: 'Ensiputti' }).click();
    await expect(page.locator('.order-list .list-item')).toHaveCount(1);
    await expect(page.locator('.preview__title')).toHaveText('Ensiputti');
    await expect(page.locator('.preview__art')).toBeVisible();
    await expectNoRawKeys(page);
    await shot(page, '05-play-setup');
    await page.getByRole('button', { name: 'Aloita', exact: true }).click();
    await expect(page).toHaveURL(/#\/game$/);

    // ---- title card
    const card = page.locator('.game-title-card');
    await expect(card).toBeVisible();
    await expect(card.locator('h2')).toHaveText('Ensiputti');
    await expect(card).toContainText('Rata 1/1');
    await expect(card).toContainText('Par 2');
    // The card fades in during the first ~200 ms of its animation: screenshot it once it is actually opaque.
    await expect.poll(async () => Number(await card.evaluate((el) => getComputedStyle(el).opacity))).toBeGreaterThan(0.9);
    await shot(page, '06-game-title-card', { animations: 'allow' });

    // ---- HUD at the first turn
    expect(await waitForTurnOrSummary(page)).toBe('turn');
    await expect(hudStat(page, 'Rata')).toHaveText('1/1');
    await expect(hudStat(page, 'Par')).toHaveText('2');
    await expect(hudStat(page, 'Lyönnit')).toHaveText('0');
    await expect(hudStat(page, 'Yhteensä')).toHaveText('0');
    await expect(page.locator('.hud__players .chip')).toHaveCount(1);
    await expect(page.locator('.hud__players .chip')).toHaveClass(/is-turn/);
    await expect(page.locator('.hud__timer')).toBeHidden(); // no turn timer in single player
    await expect(page.locator('.hud__label')).toBeHidden(); // no test-play label
    await expect(page.locator('.power')).toBeVisible(); // power bar shows while aiming is possible

    // ---- play the hole with default keyboard shots
    const strokes = await playHoleWithKeyboard(page, {
      afterFirstShot: async () => {
        await expect(hudTurn(page)).toHaveText(FI.ballMoving);
        await expect(page.locator('.hud__players .chip__strokes')).toHaveText('1');
        await shot(page, '07-game-mid-shot');
      },
    });
    test.info().annotations.push({ type: 'strokes', description: `Ensiputti ended after ${strokes} default keyboard shots` });
    expect(strokes).toBeGreaterThanOrEqual(1);
    expect(strokes).toBeLessThanOrEqual(20);

    // ---- hole summary
    const summary = page.locator('.game-panel--summary');
    await expect(summary.locator('.game-panel__kicker')).toHaveText('Rata 1/1 · Ensiputti');
    await expect(summary.locator('.game-panel__title')).not.toBeEmpty();
    await expect(summary.locator('.game-panel__sub')).toHaveText(`${strokes === 1 ? '1 lyönti' : `${strokes} lyöntiä`} · Par 2`);
    await expect(summary.locator('table')).toBeVisible();
    await expect(hudStat(page, 'Lyönnit')).toHaveText(String(strokes));
    await expect(hudTurn(page)).toHaveText('Radan yhteenveto');
    await expectNoRawKeys(page);
    // Diagnostics for the lead: the overlay panel's computed background (the screenshots show the field through it).
    const panelStyle = await summary.evaluate((el) => {
      const cs = getComputedStyle(el);
      const layer = el.parentElement ? getComputedStyle(el.parentElement) : null;
      return {
        panelBackgroundImage: cs.backgroundImage,
        panelBackgroundColor: cs.backgroundColor,
        panelOpacity: cs.opacity,
        layerBackgroundColor: layer?.backgroundColor ?? '',
        layerBackdropFilter: layer?.backdropFilter ?? '',
        layerOpacity: layer?.opacity ?? '',
      };
    });
    test.info().annotations.push({ type: 'panel-style', description: JSON.stringify(panelStyle) });
    await shot(page, '09-hole-summary');
    await summary.getByRole('button', { name: 'Jatka' }).click();

    // ---- round summary (one hole => the round ends) with the scorecard
    await expect(summary.locator('.game-panel__kicker')).toHaveText('Kierros päättyi');
    await expect(summary.locator('.game-panel__sub')).toHaveText(`Yhteensä ${strokes} lyöntiä · Par 2`);
    await expect(summary.locator('table tbody tr')).toHaveCount(2); // par row + the player
    await expect(summary.locator('table tbody tr').nth(1).locator('td').nth(1)).toHaveText(String(strokes));
    await expect(summary.getByRole('button', { name: 'Pelaa uudelleen' })).toBeVisible();
    await expectNoRawKeys(page);
    await shot(page, '10-round-summary');
    await summary.getByRole('button', { name: 'Valikkoon' }).click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator('.menu')).toBeVisible();
    expectCleanConsole(log);
  });

  test('mouse shot from the start tile, Tab scorecard, Esc pause and quit confirmation', async ({ page }) => {
    test.setTimeout(180_000);
    const log = watchConsole(page);
    await startSinglePlayer(page, ['Ensiputti', 'Kulmakivi']);
    await expect(page.locator('.game-title-card')).toBeVisible();
    expect(await waitForTurnOrSummary(page)).toBe('turn');
    // The title card fades after ~1.7 s; wait so nothing sits between the pointer and the canvas.
    await expect(page.locator('.game-title-card')).toBeHidden({ timeout: 10_000 });

    // Ball = start tile (3, 12) of Ensiputti -> world (52.5, 187.5) -> logical +15 px frame -> client px via the
    // canvas bounding box. The pull points where the ball should go (§12.3): 75 px toward the hole in the east.
    const box = await gameCanvasBox(page);
    const ball = tileToScreen(box, 3, 12);
    const target = { x: ball.x + (75 * box.width) / 765, y: ball.y - (6 * box.height) / 405 };
    await page.mouse.move(ball.x, ball.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 10 });
    const power = page.locator('.power');
    await expect(power).toBeVisible();
    // 75 / 120 px => about 62 % on the HUD power bar while the button is held.
    await expect.poll(async () => Number(await power.getAttribute('aria-valuenow'))).toBeGreaterThan(55);
    await shot(page, '08-game-aiming');
    await page.mouse.up();
    await expect(hudStat(page, 'Lyönnit')).toHaveText('1');
    await expect(page.locator('.hud__players .chip__strokes')).toHaveText('1');
    expect(await waitForTurnOrSummary(page)).toBe('turn');

    // Tab toggles the scorecard overlay (two holes, no rank column for one player).
    await page.keyboard.press('Tab');
    const scorecard = page.locator('.game-panel--scorecard');
    await expect(scorecard).toBeVisible();
    await expect(scorecard.locator('thead th')).toHaveText(['Pelaaja', '1', '2', 'Yht.', '± Par']);
    await expect(scorecard.locator('tbody tr').nth(1).locator('td').nth(1)).toHaveText('1');
    await shot(page, '11-scorecard');
    await page.keyboard.press('Tab');
    await expect(scorecard).toBeHidden();

    // Esc opens the pause menu; Lopeta asks for an in-page confirmation and returns to the menu.
    await page.keyboard.press('Escape');
    const pause = page.locator('.game-panel--pause');
    await expect(pause).toBeVisible();
    await expect(pause.locator('.game-panel__title')).toHaveText('Tauko');
    await expect(pause.getByRole('button', { name: 'Jatka' })).toBeFocused();
    await shot(page, '12-pause');
    await pause.getByRole('button', { name: 'Lopeta' }).click();
    const dialog = page.locator('.dialog');
    await expect(dialog).toContainText('Lopetetaanko kierros? Tulokset menetetään.');
    await dialog.locator('.btn--danger').click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator('.menu')).toBeVisible();
    expectCleanConsole(log);
  });
});
