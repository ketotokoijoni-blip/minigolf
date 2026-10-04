export const ErrorCode = {
  BAD_VERSION: 'BAD_VERSION',           // protocol or sim version mismatch -> client shows "Päivitä sivu"
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVER_FULL: 'SERVER_FULL',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  NAME_TAKEN: 'NAME_TAKEN',
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  ALREADY_IN_ROOM: 'ALREADY_IN_ROOM',
  NOT_HOST: 'NOT_HOST',
  NOT_IN_LOBBY: 'NOT_IN_LOBBY',
  GAME_IN_PROGRESS: 'GAME_IN_PROGRESS',
  NOT_ENOUGH_PLAYERS: 'NOT_ENOUGH_PLAYERS',
  PLAYERS_NOT_READY: 'PLAYERS_NOT_READY',
  NOT_A_PLAYER: 'NOT_A_PLAYER',         // spectator tried a player action
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  STALE_TURN: 'STALE_TURN',             // turnSeq/holeIndex mismatch
  SHOT_IN_FLIGHT: 'SHOT_IN_FLIGHT',
  INVALID_SHOT: 'INVALID_SHOT',
  INVALID_COURSE: 'INVALID_COURSE',     // error carries issues[]
  SESSION_EXPIRED: 'SESSION_EXPIRED',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
