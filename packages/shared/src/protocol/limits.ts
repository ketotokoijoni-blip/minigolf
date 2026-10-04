export const MAX_MESSAGE_BYTES = 524_288;     // 512 KB inbound frame cap; 18 courses x MAX_COURSE_BYTES = 432 KB fits; larger -> close 1009
export const MAX_COURSE_BYTES = 24_576;       // canonical JSON of one course (a typical course is ~2.6 KB; 1 200 mine objects ~ 24 KB)
export const MAX_CHAT_CHARS = 200;
export const MAX_ROOM_CODE_CHARS = 5;
export const RATE_MSGS_PER_SEC = 20;          // token bucket refill
export const RATE_BURST = 40;                 // bucket capacity
export const CHAT_MSGS_PER_10S = 5;
export const MAX_ROOMS_DEFAULT = 200;
export const MAX_CONNECTIONS_DEFAULT = 1000;
export const ROOM_IDLE_TTL_MIN_DEFAULT = 90;  // no activity -> room removed
export const ROOM_EMPTY_TTL_SEC_DEFAULT = 120;// no connections -> room removed
export const HEARTBEAT_INTERVAL_MS = 20_000;  // server ping; 2 missed pongs -> close
export const SESSION_TOKEN_BYTES = 16;
