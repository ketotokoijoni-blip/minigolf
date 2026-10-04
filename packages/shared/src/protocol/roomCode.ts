// Room codes (DESIGN D19, §11.3): 5 characters from a 32-character alphabet without I, O, 0, 1.
// The server generates codes (rooms/codes.ts, WP-F) from this alphabet; clients normalize typed input with
// normalizeRoomCode and check it with isRoomCode. No character substitution: an ambiguous character never occurs in a
// code, so typing one simply yields an invalid code.
import { MAX_ROOM_CODE_CHARS } from './limits';

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Trim, uppercase, remove whitespace and hyphens (anywhere in the string). */
export function normalizeRoomCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]+/g, '');
}

/** Exactly MAX_ROOM_CODE_CHARS characters, all from ROOM_CODE_ALPHABET (no normalization). */
export function isRoomCode(s: string): boolean {
  if (typeof s !== 'string' || s.length !== MAX_ROOM_CODE_CHARS) return false;
  for (let i = 0; i < s.length; i++) if (ROOM_CODE_ALPHABET.indexOf(s.charAt(i)) < 0) return false;
  return true;
}
