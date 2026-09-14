/** FNV-1a, for fences and fingerprints. Stable across runs; not cryptographic. */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let g = 0x2166136f;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    g ^= text.charCodeAt(i);
    g = Math.imul(g, 0x01000193) >>> 0;
  }
  return `${h.toString(16).padStart(8, '0')}${g.toString(16).padStart(8, '0')}`;
}
