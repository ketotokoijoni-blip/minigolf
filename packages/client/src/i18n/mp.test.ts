import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@puttipeli/shared/protocol/codes';
import { fiMp } from './fi.mp';
import { enMp } from './en.mp';
import { t, setLanguage } from './t';

/** System-line keys the server emits (DESIGN §11.3). */
const CHAT_KEYS = ['chat.playerJoined', 'chat.playerLeft', 'chat.spectatorJoined', 'chat.hostChanged', 'chat.gameStarted', 'chat.holeResult', 'chat.timeout', 'chat.afk'];

describe('multiplayer dictionaries', () => {
  it('fi and en have the same keys', () => {
    expect(Object.keys(enMp).sort()).toEqual(Object.keys(fiMp).sort());
  });

  it('no empty strings', () => {
    for (const d of [fiMp, enMp]) for (const [k, v] of Object.entries(d)) expect(v, k).not.toBe('');
  });

  it('has error.<code> for every ErrorCode', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(fiMp[`error.${code}`], code).toBeTypeOf('string');
      expect(enMp[`error.${code}`], code).toBeTypeOf('string');
    }
  });

  it('has every chat system line with its params', () => {
    for (const key of CHAT_KEYS) {
      expect(fiMp[key], key).toBeTypeOf('string');
      expect(enMp[key], key).toBeTypeOf('string');
    }
    expect(fiMp['chat.holeResult']).toContain('{name}');
    expect(fiMp['chat.holeResult']).toContain('{strokes}');
    expect(fiMp['chat.timeout']).toContain('{name}');
    expect(fiMp['chat.afk']).toContain('{name}');
  });

  it('placeholders match between languages', () => {
    const params = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
    for (const k of Object.keys(fiMp)) expect(params(enMp[k]!), k).toEqual(params(fiMp[k]!));
  });

  it('does not collide with core dictionary namespaces', () => {
    for (const k of Object.keys(fiMp)) expect(/^(mp|lobby|error|chat)\./.test(k), k).toBe(true);
  });

  it('is registered for t()', () => {
    setLanguage('fi');
    expect(t('chat.playerJoined', { name: 'Maija' })).toBe('Maija liittyi peliin.');
    setLanguage('en');
    expect(t('error.ROOM_NOT_FOUND')).toBe('Room not found. Check the code.');
    setLanguage('fi');
  });
});
