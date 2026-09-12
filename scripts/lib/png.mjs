/**
 * A very small PNG reader and writer.
 *
 * Enough for the icon pipeline and nothing more: 8-bit, non-interlaced, RGB or
 * RGBA in, grayscale+alpha or RGBA out. Hand-rolled rather than pulled in as a
 * dependency because the app itself has none, and an icon script is a poor
 * reason to acquire the first one.
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Read a PNG into straight (non-premultiplied) RGBA. */
export function readPng(file) {
  const buf = readFileSync(file);
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = 0;
  const parts = [];

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colour = data[9];
      if (data[12] !== 0) throw new Error(`${file}: interlaced PNGs are not supported`);
    } else if (type === 'IDAT') {
      parts.push(data);
    } else if (type === 'IEND') break;
    offset += 12 + length;
  }

  if (depth !== 8 || (colour !== 2 && colour !== 6)) {
    throw new Error(
      `${file}: expected 8-bit RGB or RGBA, got depth ${depth} colour type ${colour}`,
    );
  }

  const channels = colour === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const bytes = Buffer.alloc(stride * height);

  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? bytes[y * stride + i - channels] : 0;
      const b = y > 0 ? bytes[(y - 1) * stride + i] : 0;
      const c = i >= channels && y > 0 ? bytes[(y - 1) * stride + i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) value += paeth(a, b, c);
      bytes[y * stride + i] = value & 0xff;
    }
  }

  // Normalise to RGBA so callers never have to ask.
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i += 1, j += channels) {
    rgba[i * 4] = bytes[j];
    rgba[i * 4 + 1] = bytes[j + 1];
    rgba[i * 4 + 2] = bytes[j + 2];
    rgba[i * 4 + 3] = channels === 4 ? bytes[j + 3] : 255;
  }
  return { width, height, pixels: rgba };
}

/**
 * Write RGBA out.
 *
 * `grey: true` emits colour type 4 — one ink value, with the shape entirely in
 * the alpha channel. `ink: 0` (black) is what a macOS template image wants;
 * `ink: 255` (white) is for the platforms that do no tinting of their own and
 * need the contrast built in. See scripts/make-icons.mjs.
 */
export function writePng(file, width, height, rgba, { grey = false, ink = 0 } = {}) {
  const channels = grey ? 2 : 4;
  const stride = 1 + width * channels;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (grey) {
        raw[row + 1 + x * 2] = ink;
        raw[row + 2 + x * 2] = rgba[i + 3];
      } else {
        for (let c = 0; c < 4; c += 1) raw[row + 1 + x * 4 + c] = rgba[i + c];
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = grey ? 4 : 6;

  writeFileSync(
    file,
    Buffer.concat([
      SIGNATURE,
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}
