/**
 * Minimal PNG reader/writer for build scripts (no dependencies). Reads 8-bit RGBA/RGB/grey and
 * 1/2/4/8-bit palette images (non-interlaced), the formats LPC sprite sheets use; writes RGBA.
 */
import { deflateSync, inflateSync } from 'node:zlib';

export type Rgba = { width: number; height: number; data: Uint8Array };

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(buf: Buffer): Rgba {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]!;
      type = body[9]!;
      interlace = body[12]!;
    } else if (kind === 'PLTE') palette = body;
    else if (kind === 'tRNS') trns = body;
    else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
  }
  if (interlace) throw new Error('interlaced PNGs are not supported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type as 0 | 2 | 3 | 4 | 6];
  if (!channels) throw new Error(`unsupported PNG colour type ${type}`);
  if (depth !== 8 && type !== 3) throw new Error(`unsupported bit depth ${depth} for type ${type}`);
  const bpp = Math.max(1, (channels * depth) / 8);
  const stride = Math.ceil((width * channels * depth) / 8);
  const raw = inflateSync(Buffer.concat(idat));
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = rows.subarray(y * stride, (y + 1) * stride);
    const prev = y ? rows.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp]! : 0;
      const b = prev ? prev[x]! : 0;
      const c = prev && x >= bpp ? prev[x - bpp]! : 0;
      let v = src[x]!;
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = v & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = rows.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (type === 3) {
        const perByte = 8 / depth;
        const byte = row[Math.floor(x / perByte)]!;
        const shift = 8 - depth * ((x % perByte) + 1);
        const idx = (byte >> shift) & ((1 << depth) - 1);
        data[o] = palette![idx * 3]!;
        data[o + 1] = palette![idx * 3 + 1]!;
        data[o + 2] = palette![idx * 3 + 2]!;
        data[o + 3] = trns && idx < trns.length ? trns[idx]! : 255;
      } else if (type === 0 || type === 4) {
        const g = row[x * channels]!;
        data[o] = data[o + 1] = data[o + 2] = g;
        data[o + 3] = type === 4 ? row[x * 2 + 1]! : 255;
      } else {
        data[o] = row[x * channels]!;
        data[o + 1] = row[x * channels + 1]!;
        data[o + 2] = row[x * channels + 2]!;
        data[o + 3] = type === 6 ? row[x * 4 + 3]! : 255;
      }
    }
  }
  return { width, height, data };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(kind: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const kb = Buffer.concat([Buffer.from(kind, 'latin1'), body]);
  let c = 0xffffffff;
  for (const v of kb) c = CRC_TABLE[(c ^ v) & 0xff]! ^ (c >>> 8);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, kb, crc]);
}

export function encodePng(img: Rgba): Buffer {
  const stride = img.width * 4;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) Buffer.from(img.data.buffer, img.data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

export function crop(img: Rgba, x: number, y: number, w: number, h: number): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const sx = x + c;
      const sy = y + r;
      if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
      data.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (r * w + c) * 4);
    }
  }
  return { width: w, height: h, data };
}

export const isEmpty = (img: Rgba) => !img.data.some((v, i) => i % 4 === 3 && v > 0);
