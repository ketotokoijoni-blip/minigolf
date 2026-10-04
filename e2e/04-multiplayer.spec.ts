// (d) Multiplayer with two browser contexts on the production server: create a room, read the code from the
// lobby, join with the code, ready up, host starts, both reach #/game, the player on turn shoots with the keyboard,
// the other browser sees the stroke count and the moving ball, the turn passes, and a chat message reaches both.
import { expect, test, type Page } from '@playwright/test';
import {
  FI, captureShotMessages, expectCleanConsole, expectNoRawKeys, fieldControl, hudTurn, keyboardShot, shot, watchConsole,
} from './helpers/app';

async function openMultiplayer(page: Page, name: string): Promise<void> {
  await page.goto('/#/mp');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Moninpeli');
  await expect(page.locator('.mp-server')).toHaveText(/^Palvelin tavoitettavissa/);
  await fieldControl(page, 'Nimimerkki').fill(name);
}

/** HUD turn text once hole 1 is under way: either "Sinun vuorosi" or "Vuorossa: <name>". */
async function turnTextWhenPlaying(page: Page): Promise<string> {
  const handle = await page.waitForFunction(
    (yourTurn) => {
      const text = document.querySelector('.hud__turn')?.textContent ?? '';
      return text === yourTurn || text.startsWith('Vuorossa:') ? text : null;
    },
    FI.yourTurn,
    { timeout: 30_000, polling: 100 },
  );
  return (await handle.jsonValue()) as string;
}

test.describe('multiplayer', () => {
  test('two browsers: create, join by code, ready, start, alternate shots, chat', async ({ browser }) => {
    test.setTimeout(240_000);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    const logA = watchConsole(a);
    const logB = watchConsole(b);
    const shotsA = captureShotMessages(a);
    const shotsB = captureShotMessages(b);
    try {
      // ---- A creates a room
      await openMultiplayer(a, 'Aino');
      await expectNoRawKeys(a);
      await shot(a, '16-mp');
      await a.getByRole('button', { name: 'Luo huone' }).click();
      await expect(a).toHaveURL(/#\/room\/[A-Z2-9]{5}$/, { timeout: 20_000 });
      const code = (await a.locator('.room-code').first().textContent())?.trim() ?? '';
      expect(code).toMatch(/^[A-Z2-9]{5}$/);
      await expect(a.locator('.seat:not(.seat--free)')).toHaveCount(1);
      await expect(a.locator('.seat__host')).toBeVisible();
      await expect(a.getByRole('button', { name: 'Aloita peli' })).toBeDisabled();
      await expect(a.locator('.start-reason')).toHaveText('Tarvitaan vähintään 2 pelaajaa.');
      await expect(a.locator('.course-list .list-item')).toHaveCount(9); // default set: all built-ins

      // ---- B joins with the code
      await openMultiplayer(b, 'Bertta');
      const joinBtn = b.getByRole('button', { name: 'Liity', exact: true });
      await expect(joinBtn).toBeDisabled();
      await b.locator('#mp-code').fill(code.toLowerCase()); // normalized to upper case on input
      await expect(b.locator('#mp-code')).toHaveValue(code);
      await expect(joinBtn).toBeEnabled();
      await joinBtn.click();
      await expect(b).toHaveURL(new RegExp(`#/room/${code}$`), { timeout: 20_000 });
      await expect(b.locator('.seat:not(.seat--free)')).toHaveCount(2);
      await expect(a.locator('.seat:not(.seat--free)')).toHaveCount(2);
      await expect(a.locator('.seat__name')).toContainText(['Aino', 'Bertta']);
      await expect(a.locator('.chat__msg--system').filter({ hasText: 'Bertta liittyi peliin.' })).toBeVisible();
      await expect(a.locator('.start-reason')).toHaveText('Kaikki pelaajat eivät ole vielä valmiita.');
      await expect(b.locator('.setting-row__value').first()).toHaveText('4'); // read-only settings for a guest

      // ---- B ready, A starts
      await b.locator('.lobby-actions').getByRole('button', { name: 'Valmis', exact: true }).click();
      await expect(b.locator('.lobby-actions .start-reason')).toHaveText('Odotetaan, että isäntä aloittaa pelin.');
      await expect(a.locator('.seat__ready.is-ready')).toHaveText(/Valmis/);
      const startBtn = a.getByRole('button', { name: 'Aloita peli' });
      await expect(startBtn).toBeEnabled();
      await expectNoRawKeys(a);
      await expectNoRawKeys(b);
      await shot(a, '17-lobby-host');
      await shot(b, '18-lobby-guest');
      // The 3 s countdown (COUNTDOWN_SEC) is the only timing-coupled step of the suite, so its observer is armed
      // BEFORE the start click: the hash router keeps the same document across #/room -> #/game, so one
      // waitForFunction sees the HUD countdown appear. Should a loaded machine let the whole countdown slip past
      // before the first poll, the hole-1 title card (shown at holeStarted) is accepted as proof it ran.
      const gameStart = a.waitForFunction(
        () => {
          const countdown = document.querySelector<HTMLElement>('.hud__countdown');
          if (countdown && !countdown.hidden && countdown.textContent) return countdown.textContent;
          return document.querySelector('.game-title-card') ? 'title-card' : null;
        },
        undefined,
        { timeout: 30_000, polling: 50 },
      );
      void gameStart.catch(() => { /* reported where it is awaited below; no unhandled rejection if the click fails first */ });
      await startBtn.click();

      // ---- countdown -> hole 1 in both browsers
      await expect(a).toHaveURL(/#\/game$/, { timeout: 20_000 });
      await expect(b).toHaveURL(/#\/game$/, { timeout: 20_000 });
      const started = (await (await gameStart).jsonValue()) as string;
      expect(started, 'HUD countdown text (or the hole title card if the countdown already ended)').toMatch(/^(Peli alkaa… \d|title-card)$/);
      test.info().annotations.push({ type: 'note', description: `game start observed as: ${started}` });
      await expect(a.locator('.game-title-card h2')).toHaveText('Ensiputti', { timeout: 20_000 });
      await expect(b.locator('.game-title-card h2')).toHaveText('Ensiputti', { timeout: 20_000 });
      await expect(a.locator('.game-chat')).toBeVisible();
      await expect(b.locator('.hud__players .chip')).toHaveCount(2);

      const turnA = await turnTextWhenPlaying(a);
      const shooter = turnA === FI.yourTurn ? a : b;
      const watcher = shooter === a ? b : a;
      const shooterName = shooter === a ? 'Aino' : 'Bertta';
      const watcherName = shooter === a ? 'Bertta' : 'Aino';
      await expect(hudTurn(shooter)).toHaveText(FI.yourTurn);
      await expect(hudTurn(watcher)).toHaveText(FI.turnOf(shooterName));
      await expect(shooter.locator('.hud__timer')).toBeVisible(); // 45 s turn timer ring (room default)
      await expect(watcher.locator('.power')).toBeHidden(); // no aiming for the player waiting

      // ---- the player on turn shoots; the other browser sees it
      await keyboardShot(shooter);
      await expect(shooter.locator('.chip.is-me .chip__strokes')).toHaveText('1');
      await expect(watcher.locator('.chip.is-turn .chip__strokes')).toHaveText('1');
      await expect(watcher.locator('.chip.is-turn .chip__name')).toHaveText(shooterName);
      await shot(a, '19-mp-game-host');
      await shot(b, '20-mp-game-guest');
      test.info().annotations.push({ type: 'note', description: `first shot by ${shooterName}; watcher ${watcherName} saw strokes=1` });

      // ---- the turn passes; the other player shoots too
      await expect(hudTurn(watcher)).toHaveText(FI.yourTurn, { timeout: 60_000 });
      await expect(hudTurn(shooter)).toHaveText(FI.turnOf(watcherName));
      await keyboardShot(watcher);
      await expect(watcher.locator('.chip.is-me .chip__strokes')).toHaveText('1');
      await expect(shooter.locator('.chip.is-turn .chip__strokes')).toHaveText('1');
      await expect(shooter.locator('.chip.is-turn .chip__name')).toHaveText(watcherName);
      // Both clients sent the §12.3 default keyboard aim (hole due east of the start, 50 % power).
      expect(shotsA, 'shoot messages sent by A').toEqual(['dx=6000 dy=0']);
      expect(shotsB, 'shoot messages sent by B').toEqual(['dx=6000 dy=0']);

      // ---- chat from the host appears in both browsers
      const chatInput = a.locator('.game-chat input');
      await chatInput.fill('Moi kaikille!');
      await chatInput.press('Enter');
      await expect(a.locator('.chat__msg').filter({ hasText: 'Moi kaikille!' })).toBeVisible();
      await expect(b.locator('.chat__msg').filter({ hasText: 'Moi kaikille!' })).toBeVisible();
      await expect(b.locator('.chat__msg').filter({ hasText: 'Moi kaikille!' }).locator('.chat__from')).toHaveText('Aino');
      await expect(b.locator('.chat__msg--system').filter({ hasText: 'Peli alkoi!' })).toBeVisible();
      await expectNoRawKeys(a);
      await expectNoRawKeys(b);
      await shot(b, '21-mp-chat');

      // Both balls at rest again (the turn is back with the first shooter): where did identical east shots end up?
      await expect(hudTurn(shooter)).toHaveText(FI.yourTurn, { timeout: 60_000 });
      await expect(hudTurn(watcher)).toHaveText(FI.turnOf(shooterName));
      await shot(b, '21b-mp-balls-at-rest');

      expectCleanConsole(logA);
      expectCleanConsole(logB);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
