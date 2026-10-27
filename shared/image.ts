/**
 * Image signature + dimension sniffing for PNG, JPEG and WebP. Used by the
 * server to validate uploads independently of the client-declared type.
 */
export type SniffedImage = { contentType: 'image/png' | 'image/jpeg' | 'image/webp'; width: number; height: number };

export function sniffImage(b: Uint8Array): SniffedImage | null {
  const u32 = (o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
  const u16be = (o: number) => (b[o]! << 8) | b[o + 1]!;
  const u16le = (o: number) => b[o]! | (b[o + 1]! << 8);
  const u24le = (o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);

  // PNG: 89 50 4E 47 0D 0A 1A 0A, then IHDR width/height.
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[12] === 0x49 && b[13] === 0x48) {
    return { contentType: 'image/png', width: u32(16), height: u32(20) };
  }
  // JPEG: FF D8, walk markers to a SOFn segment.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) return null;
      const marker = b[o + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        o += 2;
        continue;
      }
      const len = u16be(o + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { contentType: 'image/jpeg', height: u16be(o + 5), width: u16be(o + 7) };
      o += 2 + len;
    }
    return null;
  }
  // WebP: RIFF....WEBP with VP8 / VP8L / VP8X chunk.
  if (b.length >= 30 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') {
    const chunk = String.fromCharCode(...b.slice(12, 16));
    if (chunk === 'VP8X') return { contentType: 'image/webp', width: u24le(24) + 1, height: u24le(27) + 1 };
    if (chunk === 'VP8L') {
      const bits = u32le(b, 21);
      return { contentType: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8 ') return { contentType: 'image/webp', width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
  }
  return null;
}

function u32le(b: Uint8Array, o: number) {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}
