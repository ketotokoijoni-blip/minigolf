// (c) Course editor through the real UI: brush painting with pointer events on the canvas, object placement,
// the live validation list, undo/redo, saving to the library, Testaa -> the play view with the test label ->
// Esc -> back to the editor with the session restored.
import { expect, test, type Page } from '@playwright/test';
import {
  FI, blurActive, expectCleanConsole, expectNoRawKeys, fieldControl, gameCanvasBox, hudStat, keyboardShot, shot,
  tileToScreen, waitForTurnOrSummary, watchConsole,
} from './helpers/app';

async function clickTile(page: Page, tx: number, ty: number): Promise<void> {
  const box = await gameCanvasBox(page);
  const p = tileToScreen(box, tx, ty);
  await page.mouse.click(p.x, p.y);
}

/** Selects the inspect tool (I), clicks a tile and returns the inspector's "Valittu ruutu" block text. */
async function inspectTile(page: Page, tx: number, ty: number): Promise<string> {
  await blurActive(page);
  await page.keyboard.press('i');
  await expect(page.locator('.ed-tool[aria-pressed="true"]')).toHaveText(/Tarkastele/);
  await clickTile(page, tx, ty);
  const info = page.locator('.ed-tileinfo');
  await expect(info).toContainText(`(${tx}, ${ty})`);
  return info.innerText();
}

const DRAFT_KEY = 'puttipeli.editorDraft.v1';

test.describe('course editor', () => {
  test('brush, objects, validation, undo/redo, save, library, test play round trip', async ({ page }) => {
    test.setTimeout(180_000);
    const log = watchConsole(page);
    await page.goto('/#/editor');
    await expect(page.locator('.ed-toolbar__title')).toHaveText('Rataeditori');
    // A fresh blank course: brush + sand selected, no validation issues, nothing to undo.
    await expect(page.locator('.ed-tool[aria-pressed="true"]')).toHaveText(/Sivellin/);
    await expect(page.locator('.ed-tab[aria-selected="true"]')).toHaveText(/Pinnat/);
    await expect(page.locator('.ed-item[aria-pressed="true"]')).toHaveText('Hiekka');
    await expect(page.locator('.ed-summary')).toHaveClass(/is-ok/);
    await expect(page.locator('.ed-summary')).toHaveText('Ei huomautuksia – rata on pelikelpoinen.');
    await expect(page.getByRole('button', { name: 'Kumoa' })).toBeDisabled();
    await expect(page.locator('.ed-status__save')).toHaveText('Ei vielä omissa radoissa');
    await expectNoRawKeys(page);
    await shot(page, '13-editor');

    // ---- brush: drag sand over tiles (10..14, 5) with pointer events on the canvas
    const box = await gameCanvasBox(page);
    const from = tileToScreen(box, 10, 5);
    const to = tileToScreen(box, 14, 5);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator('.ed-status__save')).toHaveText('Tallentamattomia muutoksia');
    await expect(page.getByRole('button', { name: 'Kumoa' })).toBeEnabled();
    // The autosaved draft (debounced) carries the painted row ...
    await expect
      .poll(async () => page.evaluate((key) => {
        const raw = localStorage.getItem(key);
        if (!raw) return '';
        const course = JSON.parse(raw) as { surface: string[] };
        return course.surface[5]?.slice(10, 15) ?? '';
      }, DRAFT_KEY))
      .toBe('sssss');
    // ... and the inspector shows the surface under the tile.
    expect(await inspectTile(page, 12, 5)).toContain('Hiekka');

    // ---- objects tab (3): removing the start makes the course invalid; Testaa is blocked
    await blurActive(page);
    await page.keyboard.press('3');
    await expect(page.locator('.ed-tab[aria-selected="true"]')).toHaveText(/Kohteet/);
    await page.locator('.ed-item').filter({ hasText: 'Poista kohde' }).click();
    await page.keyboard.press('b'); // back from the inspect tool to the brush
    await expect(page.locator('.ed-tool[aria-pressed="true"]')).toHaveText(/Sivellin/);
    await clickTile(page, 3, 12); // the blank course's start
    const summary = page.locator('.ed-summary');
    await expect(summary).toHaveClass(/is-error/);
    await expect(summary).toHaveText('1 virhettä · 0 varoitusta');
    await expect(page.locator('.ed-issue--error')).toHaveText(/Radalta puuttuu lähtöpaikka/);
    const testBtn = page.getByRole('button', { name: 'Testaa' });
    await expect(testBtn).toBeDisabled();
    await expect(testBtn).toHaveAttribute('title', 'Korjaa radan virheet ensin.');
    await expect(page.getByRole('button', { name: 'Vie JSON' })).toBeDisabled();
    await expectNoRawKeys(page);
    await shot(page, '14-editor-validation-issue');

    // ---- a new start fixes it; undo brings the error back, redo clears it again
    await page.locator('.ed-item').filter({ hasText: 'Lähtö' }).click();
    await clickTile(page, 6, 12);
    await expect(summary).toHaveClass(/is-ok/);
    await expect(testBtn).toBeEnabled();
    await blurActive(page);
    await page.keyboard.press('Control+z');
    await expect(summary).toHaveClass(/is-error/);
    await page.keyboard.press('Control+y');
    await expect(summary).toHaveClass(/is-ok/);
    // Clicking a tile-bound validation row selects that tile: produce a warning (hole next to the start) and click it.
    await page.locator('.ed-item').filter({ hasText: 'Reikä' }).click();
    await clickTile(page, 7, 12);
    await expect(summary).toHaveClass(/is-warning/);
    await expect(page.locator('.ed-issue--warning').first()).toContainText('Reikä on aivan lähdön vieressä');
    await page.locator('.ed-issue--warning.is-clickable').first().click();
    await expect(page.locator('.ed-tileinfo')).toContainText('Reikä');
    await page.keyboard.press('Control+z'); // remove the extra hole again
    await expect(summary).toHaveClass(/is-ok/);

    // ---- metadata + save to the library
    const nameField = fieldControl(page, 'Nimi');
    await nameField.fill('E2E-rata');
    await nameField.blur();
    await page.getByRole('button', { name: 'Tallenna', exact: true }).click();
    await expect(page.locator('.toast').last()).toHaveText('Rata tallennettu omiin ratoihin.');
    await expect(page.locator('.ed-status__save')).toHaveText('Tallennettu omiin ratoihin');
    await expect(page.locator('.ed-status__save')).toHaveClass(/is-clean/);

    // ---- library modal lists it as the open course
    await page.getByRole('button', { name: 'Avaa', exact: true }).click();
    const library = page.locator('.ed-library');
    await expect(library.locator('.list-item')).toHaveCount(1);
    await expect(library.locator('.list-item__title')).toHaveText('E2E-rata');
    await expect(library.locator('.badge')).toHaveText('avoinna');
    await expect(library.locator('canvas.thumb')).toBeVisible();
    await shot(page, '14b-editor-library');
    await page.locator('.ed-dialog').getByRole('button', { name: 'Sulje' }).click();
    await expect(page.locator('.ed-dialog')).toHaveCount(0);

    // ---- test play: the play view with the test label, one shot, Esc -> pause -> back to the editor
    expect(await inspectTile(page, 12, 5)).toContain('Hiekka'); // leaves the inspect tool + tile selected
    await testBtn.click();
    await expect(page).toHaveURL(/#\/game$/);
    await expect(page.locator('.hud__label')).toHaveText(FI.testPlayLabel);
    await expect(page.locator('.game-title-card h2')).toHaveText('E2E-rata');
    await expect(page.locator('.game-bar').getByRole('button', { name: 'Takaisin editoriin' })).toBeVisible();
    expect(await waitForTurnOrSummary(page)).toBe('turn');
    await keyboardShot(page);
    await expect(hudStat(page, 'Lyönnit')).toHaveText('1');
    await shot(page, '15-editor-testplay');
    await page.keyboard.press('Escape');
    const pause = page.locator('.game-panel--pause');
    await expect(pause).toBeVisible();
    await expect(pause.locator('.game-panel__kicker')).toHaveText(FI.testPlayLabel);
    await pause.getByRole('button', { name: 'Takaisin editoriin' }).click();
    await expect(page).toHaveURL(/#\/editor$/);

    // ---- restored session: course, save state, undo history, tool, selected tile, validation
    await expect(fieldControl(page, 'Nimi')).toHaveValue('E2E-rata');
    await expect(page.locator('.ed-status__save')).toHaveText('Tallennettu omiin ratoihin');
    await expect(page.getByRole('button', { name: 'Kumoa' })).toBeEnabled();
    await expect(page.locator('.ed-tool[aria-pressed="true"]')).toHaveText(/Tarkastele/);
    await expect(page.locator('.ed-tileinfo')).toContainText('(12, 5)');
    await expect(page.locator('.ed-tileinfo')).toContainText('Hiekka');
    await expect(page.locator('.ed-summary')).toHaveClass(/is-ok/);
    expect(await inspectTile(page, 6, 12)).toContain('Lähtö');
    await expectNoRawKeys(page);
    expectCleanConsole(log);
  });
});
