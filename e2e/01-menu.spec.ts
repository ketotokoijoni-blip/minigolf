// (a) Shell screens: main menu, settings (name + language round trip), help with the tileArt legend, and the
// not-yet-existing #/dev route (unknown hashes redirect home).
import { expect, test } from '@playwright/test';
import {
  expectCleanConsole, expectNoRawKeys, fieldControl, hudStat, keyboardShot, shot, waitForTurnOrSummary, watchConsole,
} from './helpers/app';

test.describe('shell screens', () => {
  test('main menu: five buttons, live server caption, footer', async ({ page }) => {
    const log = watchConsole(page);
    await page.goto('/#/');
    await expect(page.locator('.logo__title')).toHaveText('Puttipeli');

    const buttons = page.locator('.menu__buttons .menu-btn');
    await expect(buttons).toHaveCount(5);
    await expect(buttons.locator('.btn__label')).toHaveText(['Yksinpeli', 'Moninpeli', 'Rataeditori', 'Ohjeet', 'Asetukset']);

    // GET /api/stats on the same origin: the caption turns green with the live numbers.
    const caption = buttons.nth(1).locator('.btn__caption');
    await expect(caption).toHaveClass(/is-online/);
    await expect(caption).toHaveText(/^Pelaajia verkossa: \d+ · Huoneita: \d+$/);

    await expect(page.locator('.footer')).toContainText('Nimimerkki: Pelaaja');
    await expect(page.locator('.build-id')).toHaveText(/^Versio \S+$/);
    await expectNoRawKeys(page);
    await shot(page, '01-menu');
    expectCleanConsole(log);
  });

  test('#/dev tuning panel (WP-K): sliders, embedded local game, change + reset', async ({ page }) => {
    const log = watchConsole(page);
    await page.goto('/#/dev');
    await expect(page.locator('.game-bar__title')).toHaveText('Kehittäjän säätöpaneeli');
    // One slider per tunable except MAX_PULL_PX / MIN_PULL_PX (R3).
    const sliders = page.locator('input.dev-range');
    expect(await sliders.count()).toBeGreaterThanOrEqual(30);
    await expect(page.locator('#dev_MAX_PULL_PX')).toHaveCount(0);
    await expect(page.locator('#dev_MIN_PULL_PX')).toHaveCount(0);
    await expect(page.locator('select.dev-course option')).toHaveCount(9); // the built-ins; no custom courses yet
    await expect(page.locator('.dev-row.is-changed')).toHaveCount(0);
    const changedText = page.locator('.dev-changed');
    await expect(changedText).toHaveText('Kaikki arvot ovat oletuksia');

    // The embedded game (same GameController + LocalHost as #/game) is playable at once.
    await expect(page.locator('.dev-game .pp-canvas')).toBeVisible();
    expect(await waitForTurnOrSummary(page)).toBe('turn');
    await expect(hudStat(page, 'Rata')).toHaveText('1/1');
    await keyboardShot(page);
    await expect(hudStat(page, 'Lyönnit')).toHaveText('1');

    // Changing a value marks its row and the summary; "Palauta oletukset" restores everything.
    const powerNum = page.locator('input.dev-num[aria-label="POWER_SCALE"]');
    await powerNum.fill('7');
    await powerNum.blur();
    await expect(page.locator('#dev_POWER_SCALE')).toHaveValue('7');
    await expect(page.locator('.dev-row.is-changed')).toHaveCount(1);
    await expect(changedText).not.toHaveText('Kaikki arvot ovat oletuksia');
    await expectNoRawKeys(page);
    await shot(page, '22-dev');
    await page.getByRole('button', { name: 'Palauta oletukset' }).click();
    await expect(page.locator('.dev-row.is-changed')).toHaveCount(0);
    await expect(changedText).toHaveText('Kaikki arvot ovat oletuksia');
    await expect(page.locator('#dev_POWER_SCALE')).toHaveValue('5.5');
    test.info().annotations.push({
      type: 'note',
      description: `HUD label inside #/dev reads "${await page.locator('.hud__label').textContent()}" (test-play wording on the dev panel).`,
    });
    await page.getByRole('button', { name: 'Takaisin' }).click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator('.menu')).toBeVisible();
    expectCleanConsole(log);
  });

  test('settings: nickname, language to English and back, effects toggle', async ({ page }) => {
    const log = watchConsole(page);
    await page.goto('/#/settings');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Asetukset');

    const name = fieldControl(page, 'Nimimerkki');
    await name.fill('Testaaja');
    await name.blur(); // settings save on change
    await expect(name).toHaveValue('Testaaja');
    await expect(page.locator('.colour-swatch[aria-checked="true"]')).toHaveCount(1);
    await expectNoRawKeys(page);
    await shot(page, '02-settings');

    // Language: the router re-mounts the screen in English ...
    await fieldControl(page, 'Kieli').selectOption('en');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(fieldControl(page, 'Nickname')).toHaveValue('Testaaja');
    await expectNoRawKeys(page);
    await shot(page, '03-settings-english');
    // ... and back to Finnish.
    await fieldControl(page, 'Language').selectOption('fi');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Asetukset');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fi');

    // "Vähennä tehosteita" toggles the root class main.ts applies.
    const reduce = page.getByLabel('Vähennä tehosteita');
    await reduce.check();
    await expect(page.locator('html')).toHaveClass(/reduce-effects/);
    await reduce.uncheck();
    await expect(page.locator('html')).not.toHaveClass(/reduce-effects/);

    // Back home: the footer shows the new nickname.
    await page.getByRole('button', { name: 'Takaisin' }).click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator('.footer')).toContainText('Nimimerkki: Testaaja');
    expectCleanConsole(log);
  });

  test('help: controls, legend canvases drawn by tileArt, rules, multiplayer how-to', async ({ page }) => {
    const log = watchConsole(page);
    await page.goto('/#/help');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ohjeet');
    await expect(page.locator('.help-section h2')).toHaveText(['Ohjaus', 'Ruudut ja kohteet', 'Säännöt', 'Moninpeli']);
    await expect(page.locator('.controls-table tr')).toHaveCount(7);

    // One legend canvas per LEGEND_ITEMS entry (18), each with real pixels painted by tileArt.
    const legend = page.locator('.legend__art');
    await expect(legend).toHaveCount(18);
    await expect(page.locator('.legend__name')).toHaveText([
      'Nurmi', 'Hiekka', 'Jää', 'Terva', 'Vesi', 'Happo', 'Rinne', 'Seinä', 'Kulmaseinä', 'Murtuva seinä',
      'Siirrettävä palikka', 'Pomppuseinä', 'Yksisuuntainen seinä', 'Teleportti', 'Magneetti', 'Miina', 'Reikä', 'Lähtö',
    ]);
    const blank = await legend.evaluateAll((nodes) => nodes.filter((node) => {
      const canvas = node as HTMLCanvasElement;
      const ctx = canvas.getContext('2d');
      if (!ctx || canvas.width === 0 || canvas.height === 0) return true;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 0) return false;
      return true;
    }).length);
    expect(blank, 'legend canvases without any painted pixel').toBe(0);

    await expect(page.locator('.rules').first().locator('li')).toHaveCount(10);
    await expect(page.locator('.rules').nth(1).locator('li')).toHaveCount(5);
    // The multiplayer how-to ends with a #/mp button (help.screen.ts, `variant: 'ghost'`). It works, but the
    // ghost variant has a transparent background and border, so in 04-help.png it reads as a bare bold text line
    // with no button affordance. Reported to WP-E (help.screen.ts / styles.css); recorded here for the lead.
    const mpLink = page.locator('.help-section').nth(3).getByRole('button', { name: 'Moninpeli' });
    await expect(mpLink).toBeVisible();
    if (await mpLink.evaluate((el) => el.classList.contains('btn--ghost'))) {
      test.info().annotations.push({
        type: 'ui-defect',
        description: 'WP-E: help page #/mp button uses the ghost variant and renders as plain text (04-help.png, bottom)',
      });
    }
    await expectNoRawKeys(page);
    await shot(page, '04-help');
    expectCleanConsole(log);
  });
});
