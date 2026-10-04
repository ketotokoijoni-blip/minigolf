// Room code generation (DESIGN §11.3, D19): MAX_ROOM_CODE_CHARS characters drawn with crypto.randomInt from the
// shared 32-character alphabet without I, O, 0, 1 (protocol/roomCode.ts, WP-C). RoomManager retries on collision.
import { randomInt } from 'node:crypto';
import { MAX_ROOM_CODE_CHARS } from '@puttipeli/shared/protocol/limits';
import { ROOM_CODE_ALPHABET } from '@puttipeli/shared/protocol/roomCode';

export function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < MAX_ROOM_CODE_CHARS; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  return code;
}
