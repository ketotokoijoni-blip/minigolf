// Play view overlays (DESIGN §12.1 #/game, §12.4, §10.7): hole title card, hole summary, round summary, pause menu
// and the Tab scorecard, plus the play-view strings (self-registered per D26; WP-G owns no i18n file, so the
// dictionaries live here) and the pure result helpers the overlays and the tests share. All text comes from t();
// every piece of DOM is built with the shared components so the look matches ui/styles.css.
import { HOLE_INTRO_MS } from '@puttipeli/shared/constants';
import { parPlayed, ranking as rankingOf, totalStrokes } from '@puttipeli/shared/game/scoring';
import type { GameState, RankingEntry } from '@puttipeli/shared/game/types';
import { el, button } from '../ui/components';
import { renderScorecard } from '../ui/scorecard';
import { registerDictionary, t } from '../i18n/t';

// ---------------------------------------------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------------------------------------------

registerDictionary('fi', {
  'game.testPlay': 'Testaus · Esc: takaisin',
  'game.hole': 'Rata {n}/{total}',
  'game.par': 'Par {par}',
  'game.author': 'Tekijä: {author}',
  'game.leave': 'Poistu',
  'game.toMenu': 'Valikkoon',
  'game.toEditor': 'Takaisin editoriin',
  'game.toLobby': 'Takaisin aulaan',
  'game.scorecard': 'Tuloskortti',
  'game.scorecard.hint': 'Tab avaa ja sulkee tuloskortin',
  'game.pause': 'Tauko',
  'game.pause.hint': 'Esc jatkaa peliä.',
  'game.resume': 'Jatka',
  'game.quit': 'Lopeta',
  'game.quit.confirm': 'Lopetetaanko kierros? Tulokset menetetään.',
  'game.leaveRoom.confirm': 'Poistutaanko huoneesta?',
  'game.continue': 'Jatka',
  'game.continue.hint': 'Välilyönti, Enter tai napsautus jatkaa',
  'game.waitingOthers': 'Odotetaan muita pelaajia…',
  'game.waitingPlayers': 'Odotetaan pelaajia…',
  'game.ready': 'Valmis',
  'game.holeSummary.title': 'Rata {n}/{total} pelattu',
  'game.holeSummary.spectator': 'Rata pelattu',
  'game.strokes': '{n} lyöntiä',
  'game.strokes.one': '1 lyönti',
  'game.result.holeInOne': 'Hole-in-one!',
  'game.result.albatross': 'Albatrossi',
  'game.result.eagle': 'Eagle',
  'game.result.birdie': 'Birdie',
  'game.result.par': 'Par',
  'game.result.bogey': 'Bogey',
  'game.result.doubleBogey': 'Tupla-bogey',
  'game.result.over': '+{n}',
  'game.result.maxStrokes': 'Lyöntiraja täyttyi',
  'game.result.notPlayed': 'Ei pelattu',
  'game.roundSummary.title': 'Kierros päättyi',
  'game.roundSummary.testPlay': 'Testaus päättyi',
  'game.roundSummary.total': 'Yhteensä {total} lyöntiä · Par {par}',
  'game.roundSummary.winner': 'Voittaja: {name}',
  'game.roundSummary.tie': 'Tasapeli',
  'game.playAgain': 'Pelaa uudelleen',
  'game.aborted': 'Peli keskeytyi',
  'game.timedOut': 'Vuoron aikaraja ylittyi: +1 lyönti',
  'game.desync': 'Lyönnin toisto poikkesi palvelimen tuloksesta – tila päivitettiin',
  'game.shotTimeout': 'Pallo ei pysähtynyt 30 sekunnissa – lyönti katkaistiin',
  'game.noCourses': 'Kierrokselle ei ole valittu ratoja.',
  'game.startFailed': 'Pelin käynnistys epäonnistui.',
  'game.error': 'Virhe: {code}',
  'game.close': 'Sulje',
});

registerDictionary('en', {
  'game.testPlay': 'Test play · Esc: back',
  'game.hole': 'Hole {n}/{total}',
  'game.par': 'Par {par}',
  'game.author': 'Author: {author}',
  'game.leave': 'Leave',
  'game.toMenu': 'Menu',
  'game.toEditor': 'Back to the editor',
  'game.toLobby': 'Back to the lobby',
  'game.scorecard': 'Scorecard',
  'game.scorecard.hint': 'Tab opens and closes the scorecard',
  'game.pause': 'Paused',
  'game.pause.hint': 'Esc resumes the game.',
  'game.resume': 'Resume',
  'game.quit': 'Quit',
  'game.quit.confirm': 'End the round? The scores will be lost.',
  'game.leaveRoom.confirm': 'Leave the room?',
  'game.continue': 'Continue',
  'game.continue.hint': 'Space, Enter or a click continues',
  'game.waitingOthers': 'Waiting for the other players…',
  'game.waitingPlayers': 'Waiting for the players…',
  'game.ready': 'Ready',
  'game.holeSummary.title': 'Hole {n}/{total} complete',
  'game.holeSummary.spectator': 'Hole complete',
  'game.strokes': '{n} strokes',
  'game.strokes.one': '1 stroke',
  'game.result.holeInOne': 'Hole-in-one!',
  'game.result.albatross': 'Albatross',
  'game.result.eagle': 'Eagle',
  'game.result.birdie': 'Birdie',
  'game.result.par': 'Par',
  'game.result.bogey': 'Bogey',
  'game.result.doubleBogey': 'Double bogey',
  'game.result.over': '+{n}',
  'game.result.maxStrokes': 'Stroke limit reached',
  'game.result.notPlayed': 'Not played',
  'game.roundSummary.title': 'Round complete',
  'game.roundSummary.testPlay': 'Test play complete',
  'game.roundSummary.total': 'Total {total} strokes · Par {par}',
  'game.roundSummary.winner': 'Winner: {name}',
  'game.roundSummary.tie': 'Tie',
  'game.playAgain': 'Play again',
  'game.aborted': 'The game was aborted',
  'game.timedOut': 'Turn time ran out: +1 stroke',
  'game.desync': 'The shot replay differed from the server result – state refreshed',
  'game.shotTimeout': 'The ball did not stop within 30 seconds – the shot was cut off',
  'game.noCourses': 'No courses were selected for the round.',
  'game.startFailed': 'Starting the game failed.',
  'game.error': 'Error: {code}',
  'game.close': 'Close',
});

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers (tested in summaries.test.ts)
// ---------------------------------------------------------------------------------------------------------------

export type HoleResultKind = 'holeInOne' | 'albatross' | 'eagle' | 'birdie' | 'par' | 'bogey' | 'doubleBogey' | 'over' | 'maxStrokes' | 'notPlayed';

export interface HoleResult { kind: HoleResultKind; strokes: number; diff: number }

/** Classifies a finished hole: strokes vs par, with the stroke-limit case (not holed) and hole-in-one first. */
export function holeResult(strokes: number, par: number, maxStrokes: number, holed: boolean): HoleResult {
  if (strokes < 0) return { kind: 'notPlayed', strokes: 0, diff: 0 };
  const diff = strokes - par;
  if (!holed && strokes >= maxStrokes) return { kind: 'maxStrokes', strokes, diff };
  if (strokes === 1 && holed) return { kind: 'holeInOne', strokes, diff };
  if (diff <= -3) return { kind: 'albatross', strokes, diff };
  if (diff === -2) return { kind: 'eagle', strokes, diff };
  if (diff === -1) return { kind: 'birdie', strokes, diff };
  if (diff === 0) return { kind: 'par', strokes, diff };
  if (diff === 1) return { kind: 'bogey', strokes, diff };
  if (diff === 2) return { kind: 'doubleBogey', strokes, diff };
  return { kind: 'over', strokes, diff };
}

/** Localized label for a hole result ('+4' for large overs). */
export function holeResultLabel(r: HoleResult): string {
  if (r.kind === 'over') return t('game.result.over', { n: r.diff });
  return t(`game.result.${r.kind}`);
}

/** Strokes relative to par as text: 'E', '+3', '−2' (typographic minus). */
export function formatDiff(diff: number): string {
  if (diff === 0) return 'E';
  return diff > 0 ? `+${diff}` : `−${-diff}`;
}

export function strokesLabel(n: number): string {
  return n === 1 ? t('game.strokes.one') : t('game.strokes', { n });
}

/**
 * The local player's result on the hole the state is summarising (the current hole during holeSummary). `holed`
 * comes from the deciding shotTaken event (the controller remembers it per player; GameState keeps no shot result).
 * When it is unknown (joined by snapshot) it is inferred: a player below the stroke limit who is done has holed out,
 * one at the limit has not — which misses a hole-out with the very last allowed stroke, hence the explicit flag.
 */
export function localHoleResult(state: GameState, playerId: string, holed?: boolean): HoleResult | null {
  const course = state.holeIndex >= 0 ? state.courses[state.holeIndex] : undefined;
  if (!course || !playerId) return null;
  const strokes = state.strokes[playerId]?.[state.holeIndex] ?? -1;
  if (strokes < 0) return holeResult(-1, course.rules.par, course.rules.maxStrokes, false);
  const known = holed ?? (strokes < course.rules.maxStrokes || state.holeDone[playerId] !== true);
  return holeResult(strokes, course.rules.par, course.rules.maxStrokes, known);
}

export interface RankingLine { rank: number; playerId: string; name: string; colour: number; total: number; diff: number; left: boolean }

/** Ranking rows for the round summary (state.ranking from roundEnded, else computed). */
export function rankingLines(state: GameState): RankingLine[] {
  const entries: RankingEntry[] = state.ranking ?? rankingOf(state);
  const out: RankingLine[] = [];
  for (const e of entries) {
    const p = state.players.find((q) => q.id === e.playerId);
    if (!p) continue;
    out.push({ rank: e.rank, playerId: p.id, name: p.name, colour: p.colour, total: e.total, diff: e.total - parPlayed(state, p.id), left: p.leftRound });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------------------------------------------

export interface OverlayContext {
  localPlayerId: string;      // '' for a spectator
  kind: 'local' | 'remote';
  testPlay: boolean;
  isHost: boolean;
  /** Per player: did the latest shot on the current hole hole out? Missing = not observed (see localHoleResult). */
  holed?: Readonly<Record<string, boolean>>;
}
export interface HoleSummaryActions { onContinue(): void }
export interface RoundSummaryActions {
  /** Local only: "Pelaa uudelleen". */
  onRestart?: () => void;
  /** "Valikkoon" / "Takaisin editoriin" / "Poistu". */
  onLeave: () => void;
  /** Remote: "Valmis" (summaryReady). */
  onReady?: () => void;
  /** Remote host: "Takaisin aulaan". */
  onBackToLobby?: () => void;
}
export interface PauseActions { onResume(): void; onQuit(): void }

export type SummaryKind = 'none' | 'hole' | 'round';

export interface Overlays {
  /** Title card "Rata 1/9 – Ensiputti – Par 2", fading out after `durationMs` (never blocks input). */
  showTitleCard(state: GameState, durationMs?: number): void;
  showHoleSummary(state: GameState, ctx: OverlayContext, actions: HoleSummaryActions): void;
  showRoundSummary(state: GameState, ctx: OverlayContext, actions: RoundSummaryActions): void;
  hideSummary(): void;
  readonly summary: SummaryKind;
  showPause(ctx: OverlayContext, actions: PauseActions): void;
  hidePause(): void;
  readonly paused: boolean;
  toggleScorecard(state: GameState, localPlayerId: string): void;
  closeScorecard(): void;
  readonly scorecardOpen: boolean;
  /** Re-renders whatever is open from a newer state (scores, ready marks). */
  update(state: GameState, ctx: OverlayContext): void;
  destroy(): void;
}

interface Layer { root: HTMLElement; actions?: HoleSummaryActions | RoundSummaryActions }

const isInput = (n: EventTarget | null): boolean => {
  const e = n as HTMLElement | null;
  return !!e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'BUTTON' || e.isContentEditable === true);
};

/** DOM overlays stacked inside `host` (an absolutely positioned element covering the stage). */
export function createOverlays(host: HTMLElement): Overlays {
  ensureGameStyles();
  host.classList.add('game-overlays');
  let title: { root: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null;
  let summaryLayer: Layer | null = null;
  let summaryKind: SummaryKind = 'none';
  let summaryActions: HoleSummaryActions | RoundSummaryActions | null = null;
  let pauseLayer: HTMLElement | null = null;
  let scorecardLayer: HTMLElement | null = null;

  const clearTitle = (): void => {
    if (!title) return;
    clearTimeout(title.timer);
    title.root.remove();
    title = null;
  };

  const scorecardBlock = (state: GameState, localId: string): HTMLElement => {
    const wrap = el('div', { class: 'game-panel__scorecard' });
    renderScorecard(wrap, state, localId);
    return wrap;
  };

  const holeSummaryPanel = (state: GameState, ctx: OverlayContext, actions: HoleSummaryActions): HTMLElement => {
    const course = state.courses[state.holeIndex];
    const total = state.courses.length;
    const kicker = course ? `${t('game.hole', { n: state.holeIndex + 1, total })} · ${course.name}` : t('game.holeSummary.spectator');
    const result = localHoleResult(state, ctx.localPlayerId, ctx.holed?.[ctx.localPlayerId]);
    const titleText = result ? holeResultLabel(result) : t('game.holeSummary.spectator');
    const sub = result && course
      ? `${strokesLabel(result.strokes)} · ${t('game.par', { par: course.rules.par })}`
      : course ? t('game.par', { par: course.rules.par }) : '';
    const ready = ctx.localPlayerId !== '' && state.summaryReady[ctx.localPlayerId] === true;
    const canContinue = ctx.localPlayerId !== '' && !ready;
    const titleEl = el('h2', { class: 'game-panel__title' }, titleText);
    if (result && result.kind !== 'notPlayed') titleEl.classList.add(result.diff < 0 ? 'game-result--under' : result.diff > 0 ? 'game-result--over' : 'game-result--par');
    const actionsRow = el('div', { class: 'game-panel__actions' });
    if (canContinue) actionsRow.append(button(t('game.continue'), actions.onContinue, { primary: true, className: 'game-panel__primary' }));
    const hint = el('div', { class: 'game-panel__hint' },
      ctx.localPlayerId === '' ? t('game.waitingPlayers') : ready ? t('game.waitingOthers') : t('game.continue.hint'));
    return el('div', { class: 'game-panel game-panel--summary', role: 'dialog', 'aria-modal': 'false', 'aria-label': kicker },
      el('div', { class: 'game-panel__kicker' }, kicker),
      titleEl,
      el('div', { class: 'game-panel__sub' }, sub),
      scorecardBlock(state, ctx.localPlayerId),
      actionsRow,
      hint,
    );
  };

  const roundSummaryPanel = (state: GameState, ctx: OverlayContext, actions: RoundSummaryActions): HTMLElement => {
    const lines = rankingLines(state);
    const kicker = ctx.testPlay ? t('game.roundSummary.testPlay') : t('game.roundSummary.title');
    const me = ctx.localPlayerId !== '' ? state.players.find((p) => p.id === ctx.localPlayerId) ?? null : null;
    let titleText: string;
    let titleClass = '';
    if (lines.length <= 1 && me) {
      const diff = totalStrokes(state, me.id) - parPlayed(state, me.id);
      titleText = formatDiff(diff);
      titleClass = diff < 0 ? 'game-result--under' : diff > 0 ? 'game-result--over' : 'game-result--par';
    } else if (lines.length > 1) {
      const winners = lines.filter((l) => l.rank === 1 && !l.left);
      titleText = winners.length === 1 ? t('game.roundSummary.winner', { name: winners[0]!.name }) : t('game.roundSummary.tie');
    } else {
      titleText = kicker;
    }
    const titleEl = el('h2', { class: `game-panel__title ${titleClass}`.trim() }, titleText);
    const sub = me
      ? t('game.roundSummary.total', { total: totalStrokes(state, me.id), par: parPlayed(state, me.id) })
      : '';
    const panel = el('div', { class: 'game-panel game-panel--summary', role: 'dialog', 'aria-modal': 'false', 'aria-label': kicker },
      el('div', { class: 'game-panel__kicker' }, kicker),
      titleEl,
      el('div', { class: 'game-panel__sub' }, sub),
    );
    if (lines.length > 1) {
      const list = el('ol', { class: 'game-ranking' });
      for (const l of lines) {
        const dot = el('span', { class: 'chip__dot' });
        dot.style.setProperty('--player-colour', `var(--player-${l.colour})`);
        const item = el('li', { class: l.left ? 'is-left' : '' },
          el('span', { class: 'rank' }, `${l.rank}.`), dot,
          el('span', { class: 'name' }, l.name),
          el('span', { class: 'muted' }, `${l.total} (${formatDiff(l.diff)})`));
        if (l.playerId === ctx.localPlayerId) item.classList.add('is-me');
        list.append(item);
      }
      panel.append(list);
    }
    panel.append(scorecardBlock(state, ctx.localPlayerId));

    const row = el('div', { class: 'game-panel__actions' });
    const hint = el('div', { class: 'game-panel__hint' });
    if (ctx.kind === 'local') {
      if (actions.onRestart) row.append(button(t('game.playAgain'), actions.onRestart, { primary: !ctx.testPlay }));
      row.append(button(ctx.testPlay ? t('game.toEditor') : t('game.toMenu'), actions.onLeave, { primary: ctx.testPlay }));
    } else {
      const ready = ctx.localPlayerId !== '' && state.summaryReady[ctx.localPlayerId] === true;
      if (actions.onReady && ctx.localPlayerId !== '') {
        row.append(button(t('game.ready'), actions.onReady, { primary: !ready, disabled: ready }));
        if (ready) hint.textContent = t('game.waitingOthers');
      }
      if (actions.onBackToLobby && ctx.isHost) row.append(button(t('game.toLobby'), actions.onBackToLobby, { primary: ready }));
      row.append(button(t('game.leave'), actions.onLeave, { variant: 'ghost' }));
    }
    panel.append(row, hint);
    return panel;
  };

  const mountSummary = (panel: HTMLElement, kind: SummaryKind, onBackdrop: (() => void) | null): void => {
    summaryLayer?.root.remove();
    const layer = el('div', { class: 'game-layer game-layer--modal' }, panel);
    if (onBackdrop) layer.addEventListener('click', (e) => { if (e.target === layer) onBackdrop(); });
    host.append(layer);
    summaryLayer = { root: layer };
    summaryKind = kind;
    const primary = panel.querySelector<HTMLElement>('.btn--primary') ?? panel.querySelector<HTMLElement>('button');
    primary?.focus();
    // The pause layer stays on top of a summary.
    if (pauseLayer) host.append(pauseLayer);
  };

  const pausePanel = (ctx: OverlayContext, actions: PauseActions): HTMLElement => {
    const quitLabel = ctx.kind === 'remote' ? t('game.leave') : ctx.testPlay ? t('game.toEditor') : t('game.quit');
    return el('div', { class: 'game-panel game-panel--pause', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('game.pause') },
      el('div', { class: 'game-panel__kicker' }, ctx.testPlay ? t('game.testPlay') : t('app.title')),
      el('h2', { class: 'game-panel__title' }, t('game.pause')),
      el('div', { class: 'game-panel__sub' }, t('game.pause.hint')),
      el('div', { class: 'game-panel__actions' },
        button(t('game.resume'), actions.onResume, { primary: true }),
        button(quitLabel, actions.onQuit, { variant: ctx.testPlay ? undefined : 'danger' }),
      ),
    );
  };

  const api: Overlays = {
    showTitleCard(state, durationMs = HOLE_INTRO_MS + 700) {
      clearTitle();
      const course = state.courses[state.holeIndex];
      if (!course) return;
      const meta = [t('game.par', { par: course.rules.par })];
      if (course.author) meta.push(t('game.author', { author: course.author }));
      const card = el('div', { class: 'game-title-card', 'aria-live': 'polite' },
        el('div', { class: 'game-panel__kicker' }, t('game.hole', { n: state.holeIndex + 1, total: state.courses.length })),
        el('h2', {}, course.name),
        el('div', { class: 'game-title-card__meta' }, meta.join(' · ')),
        course.description ? el('div', { class: 'game-title-card__desc' }, course.description) : null,
      );
      card.style.setProperty('--dur', `${durationMs}ms`);
      const layer = el('div', { class: 'game-layer game-layer--title' }, card);
      host.append(layer);
      title = { root: layer, timer: setTimeout(() => { if (title?.root === layer) { layer.remove(); title = null; } }, durationMs) };
    },

    showHoleSummary(state, ctx, actions) {
      summaryActions = actions;
      mountSummary(holeSummaryPanel(state, ctx, actions), 'hole', () => { if (ctx.localPlayerId && !state.summaryReady[ctx.localPlayerId]) actions.onContinue(); });
    },

    showRoundSummary(state, ctx, actions) {
      summaryActions = actions;
      mountSummary(roundSummaryPanel(state, ctx, actions), 'round', null);
    },

    hideSummary() {
      summaryLayer?.root.remove();
      summaryLayer = null;
      summaryKind = 'none';
      summaryActions = null;
    },

    get summary() { return summaryKind; },

    showPause(ctx, actions) {
      pauseLayer?.remove();
      const panel = pausePanel(ctx, actions);
      pauseLayer = el('div', { class: 'game-layer game-layer--modal game-layer--pause' }, panel);
      host.append(pauseLayer);
      panel.querySelector<HTMLElement>('.btn--primary')?.focus();
    },

    hidePause() {
      pauseLayer?.remove();
      pauseLayer = null;
    },

    get paused() { return pauseLayer !== null; },

    toggleScorecard(state, localPlayerId) {
      if (scorecardLayer) { api.closeScorecard(); return; }
      const card = el('div', { class: 'game-panel game-panel--scorecard', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('game.scorecard') },
        el('div', { class: 'game-panel__kicker' }, t('game.scorecard')),
        scorecardBlock(state, localPlayerId),
        el('div', { class: 'game-panel__actions' }, button(t('game.close'), () => api.closeScorecard(), { primary: true })),
        el('div', { class: 'game-panel__hint' }, t('game.scorecard.hint')),
      );
      scorecardLayer = el('div', { class: 'game-layer game-layer--modal game-layer--scorecard' }, card);
      scorecardLayer.addEventListener('click', (e) => { if (e.target === scorecardLayer) api.closeScorecard(); });
      host.append(scorecardLayer);
      if (pauseLayer) host.append(pauseLayer);
      card.querySelector<HTMLElement>('.btn--primary')?.focus();
    },

    closeScorecard() {
      scorecardLayer?.remove();
      scorecardLayer = null;
    },

    get scorecardOpen() { return scorecardLayer !== null; },

    update(state, ctx) {
      if (scorecardLayer) {
        const wrap = scorecardLayer.querySelector<HTMLElement>('.game-panel__scorecard');
        if (wrap) renderScorecard(wrap, state, ctx.localPlayerId);
      }
      if (summaryLayer && summaryActions) {
        const focused = isInput(host.ownerDocument.activeElement) && summaryLayer.root.contains(host.ownerDocument.activeElement);
        const panel = summaryKind === 'hole'
          ? holeSummaryPanel(state, ctx, summaryActions as HoleSummaryActions)
          : roundSummaryPanel(state, ctx, summaryActions as RoundSummaryActions);
        summaryLayer.root.replaceChildren(panel);
        if (focused) (panel.querySelector<HTMLElement>('.btn--primary') ?? panel.querySelector<HTMLElement>('button'))?.focus();
      }
    },

    destroy() {
      clearTitle();
      api.hideSummary();
      api.hidePause();
      api.closeScorecard();
      host.replaceChildren();
    },
  };
  return api;
}

// ---------------------------------------------------------------------------------------------------------------
// Styles (injected once; WP-G owns no stylesheet, so the play-view rules travel with this module)
// ---------------------------------------------------------------------------------------------------------------

const STYLE_ID = 'pp-game-styles';

const GAME_CSS = `
.game-screen{display:flex;flex-direction:column;height:100vh;height:100dvh;padding:10px 14px 12px;gap:8px;overflow:hidden}
.game-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.game-bar__title{font-family:var(--font-display);font-weight:700;font-size:1.05rem;letter-spacing:.02em}
.game-bar__spacer{flex:1}
.game-main{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr);gap:12px}
.game-main--chat{grid-template-columns:minmax(0,1fr) 300px}
@media (max-width:900px){.game-main--chat{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto}.game-chat .chat__messages{max-height:140px}}
.game-root{display:flex;flex-direction:column;min-height:0;gap:8px}
.game-hud{flex:none}
.game-stage{position:relative;flex:1;min-height:200px;display:flex;align-items:center;justify-content:center}
.game-stage .pp-stage{box-shadow:0 12px 32px rgba(0,0,0,.45);border-radius:4px}
.game-overlays{position:absolute;inset:0;pointer-events:none}
.game-layer{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px}
.game-layer--modal{pointer-events:auto;background:rgba(2,10,5,.55);backdrop-filter:blur(2px);animation:game-fade 140ms ease-out}
.game-layer--pause{z-index:3}
.game-layer--scorecard{z-index:2}
.game-panel{background:linear-gradient(180deg,var(--felt-800),var(--felt-900));border:1px solid var(--line-strong);border-radius:var(--radius);box-shadow:var(--shadow);padding:20px 24px;width:min(680px,100%);max-height:100%;overflow:auto;display:flex;flex-direction:column;gap:12px;text-align:center}
.game-panel--pause{width:min(400px,100%)}
.game-panel__kicker{color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-size:.8rem;font-weight:600}
.game-panel__title{font-size:2rem;margin:0;color:var(--gold)}
.game-panel__sub{color:var(--cream-dim)}
.game-panel__actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.game-panel__hint{color:var(--muted);font-size:.82rem;min-height:1.2em}
.game-panel__scorecard{text-align:left}
.game-result--under{color:#9fe3b4}
.game-result--over{color:#ffb3a6}
.game-result--par{color:var(--cream)}
.game-ranking{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.game-ranking li{display:flex;gap:10px;align-items:center;justify-content:center}
.game-ranking li.is-me .name{font-weight:700}
.game-ranking li.is-left{opacity:.55}
.game-ranking .rank{color:var(--gold);font-weight:700;min-width:2em;text-align:right}
.game-title-card{pointer-events:none;text-align:center;background:rgba(6,22,13,.82);border:1px solid var(--line-strong);border-radius:var(--radius);padding:18px 34px;box-shadow:var(--shadow);animation:game-title var(--dur,1.7s) ease-in-out both;max-width:min(560px,100%)}
.game-title-card h2{font-size:clamp(1.6rem,4vw,2.4rem);margin:4px 0;color:var(--cream)}
.game-title-card__meta{color:var(--gold)}
.game-title-card__desc{color:var(--muted);font-size:.9rem;margin-top:6px}
.game-chat{display:flex;flex-direction:column;min-height:0}
.game-chat .chat{flex:1;min-height:0}
@keyframes game-fade{from{opacity:0}to{opacity:1}}
@keyframes game-title{0%{opacity:0;transform:translateY(8px) scale(.98)}12%{opacity:1;transform:none}75%{opacity:1}100%{opacity:0;transform:translateY(-6px)}}
.reduce-effects .game-title-card{animation:none}
`;

/** Appends the play-view stylesheet to <head> once (no-op without a DOM). */
export function ensureGameStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = GAME_CSS;
  document.head.append(style);
}
