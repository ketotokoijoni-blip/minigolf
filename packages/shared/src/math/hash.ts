// FNV-1a 32-bit over UTF-8 bytes (strings) or raw bytes. Pure int32 arithmetic (Math.imul, >>> 0), so the result is
// identical on every JS engine. Used for course ids (course/canonical.ts, WP-A) and the sim checksum (sim/checksum.ts, WP-B).

// Module-private (DESIGN §6.7 exports only fnv1a32 and hex8; callers pass the second basis 0x01000193 ^ 0x811c9dc5 themselves).
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const mix = (h: number, byte: number): number => Math.imul(h ^ byte, FNV_PRIME);

/**
 * Unsigned 32-bit FNV-1a hash of `input`.
 * Strings are hashed as their UTF-8 bytes; lone surrogates become U+FFFD, exactly like TextEncoder (no DOM/Node
 * dependency, shared stays lib-free). `offsetBasis` (default 0x811c9dc5) lets callers derive independent hashes of
 * the same input (course ids use 0x01000193 ^ 0x811c9dc5 as the second basis) or chain hashes by passing a previous
 * result as the basis (sim checksum).
 */
export function fnv1a32(input: string | Uint8Array, offsetBasis: number = FNV_OFFSET_BASIS): number {
  let h = offsetBasis | 0;
  if (typeof input === 'string') {
    const n = input.length;
    for (let i = 0; i < n; i++) {
      let c = input.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdfff) {
        const next = c <= 0xdbff && i + 1 < n ? input.charCodeAt(i + 1) : 0;
        if (next >= 0xdc00 && next <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
          i++;
        } else {
          c = 0xfffd; // unpaired surrogate -> replacement character, as TextEncoder does
        }
      }
      if (c < 0x80) {
        h = mix(h, c);
      } else if (c < 0x800) {
        h = mix(h, 0xc0 | (c >> 6));
        h = mix(h, 0x80 | (c & 0x3f));
      } else if (c < 0x10000) {
        h = mix(h, 0xe0 | (c >> 12));
        h = mix(h, 0x80 | ((c >> 6) & 0x3f));
        h = mix(h, 0x80 | (c & 0x3f));
      } else {
        h = mix(h, 0xf0 | (c >> 18));
        h = mix(h, 0x80 | ((c >> 12) & 0x3f));
        h = mix(h, 0x80 | ((c >> 6) & 0x3f));
        h = mix(h, 0x80 | (c & 0x3f));
      }
    }
  } else {
    const n = input.length;
    for (let i = 0; i < n; i++) h = mix(h, input[i] ?? 0);
  }
  return h >>> 0;
}

/** Lower-case, zero-padded 8-digit hex form of an unsigned 32-bit number (the low 32 bits of `n`). */
export function hex8(n: number): string {
  return (n >>> 0).toString(16).padStart(8, '0');
}
