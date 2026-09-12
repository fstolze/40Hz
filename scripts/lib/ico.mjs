/**
 * Minimal ICO writer.
 *
 * Windows draws the tray icon at a size that follows the display scaling —
 * 16px at 100%, 20px at 125%, 24px at 150%, 32px at 200% — and a PNG offers it
 * one size to stretch. An .ico carries every size, so Windows picks rather than
 * resamples, which is the difference between a crisp glyph and a soft one.
 *
 * Entries are written as 32-bit BMP DIBs rather than embedded PNGs. Both are
 * legal since Vista, and PNG entries are the smaller file, but DIB is what
 * every shell reads without argument and these images are tiny either way.
 */

import { writeFileSync } from 'node:fs';

/**
 * `images` is [{ width, height, pixels }] in straight RGBA, largest or
 * smallest first — order is not significant, Windows reads the directory.
 */
export function writeIco(file, images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  const blobs = [];
  // The AND mask is 1 bit per pixel, each row padded to a 4-byte boundary. It
  // predates alpha and is ignored for 32-bit icons, but leaving it out makes
  // the entry malformed, so it is written as zeros.
  for (const { width, height, pixels } of images) {
    const maskStride = Math.ceil(width / 32) * 4;
    const dib = Buffer.alloc(40 + width * 4 * height + maskStride * height);
    dib.writeUInt32LE(40, 0); // biSize
    dib.writeInt32LE(width, 4);
    dib.writeInt32LE(height * 2, 8); // XOR and AND masks stacked
    dib.writeUInt16LE(1, 12); // biPlanes
    dib.writeUInt16LE(32, 14); // biBitCount

    for (let y = 0; y < height; y += 1) {
      // DIB rows run bottom-up.
      const src = (height - 1 - y) * width * 4;
      const dst = 40 + y * width * 4;
      for (let x = 0; x < width; x += 1) {
        const s = src + x * 4;
        const d = dst + x * 4;
        dib[d] = pixels[s + 2]; // B
        dib[d + 1] = pixels[s + 1]; // G
        dib[d + 2] = pixels[s]; // R
        dib[d + 3] = pixels[s + 3]; // A
      }
    }
    blobs.push(dib);
  }

  let offset = header.length + directory.length;
  images.forEach(({ width, height }, i) => {
    const entry = i * 16;
    // 0 means 256 in a byte-wide field; nothing here is that large, but the
    // encoding is part of the format rather than an edge case worth omitting.
    directory[entry] = width >= 256 ? 0 : width;
    directory[entry + 1] = height >= 256 ? 0 : height;
    directory[entry + 2] = 0; // palette size
    directory[entry + 3] = 0; // reserved
    directory.writeUInt16LE(1, entry + 4); // planes
    directory.writeUInt16LE(32, entry + 6); // bit count
    directory.writeUInt32LE(blobs[i].length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += blobs[i].length;
  });

  writeFileSync(file, Buffer.concat([header, directory, ...blobs]));
}
