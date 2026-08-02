import zlib from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
};

/**
 * Minimal PNG reader for the 8-bit non-interlaced files the cache extractor and
 * the wiki both produce. Returns straight RGBA so callers can compare pixels
 * without caring about the source colour type.
 */
export const decodePng = (buffer) => {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a png");

  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = 0;
  let interlace = 0;
  let palette = null;
  // tRNS means different things per colour type: per-entry alpha for palette
  // images, but a single fully transparent colour key for greyscale and RGB.
  // Treating the key case as opaque turns a transparent background into opaque
  // black, which looks exactly like a broken sprite.
  let transparency = null;
  const idat = [];

  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colourType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "tRNS") {
      transparency = data;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
  if (interlace !== 0) throw new Error("interlaced png unsupported");

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType];
  if (!channels) throw new Error(`unsupported colour type ${colourType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const lines = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const source = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const target = lines.subarray(y * stride, y * stride + stride);
    const previous = y > 0 ? lines.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x += 1) {
      const value = source[x];
      const left = x >= channels ? target[x - channels] : 0;
      const up = previous ? previous[x] : 0;
      const upLeft = previous && x >= channels ? previous[x - channels] : 0;
      let out = value;
      if (filter === 1) out = value + left;
      else if (filter === 2) out = value + up;
      else if (filter === 3) out = value + ((left + up) >> 1);
      else if (filter === 4) out = value + paeth(left, up, upLeft);
      target[x] = out & 0xff;
    }
  }

  // For 8-bit samples the 16-bit key values in tRNS carry the value in the low
  // byte of each pair.
  const greyKey =
    colourType === 0 && transparency?.length >= 2 ? transparency[1] : null;
  const rgbKey =
    colourType === 2 && transparency?.length >= 6
      ? [transparency[1], transparency[3], transparency[5]]
      : null;

  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const source = index * channels;
    const target = index * 4;
    if (colourType === 6) {
      lines.copy(rgba, target, source, source + 4);
    } else if (colourType === 2) {
      lines.copy(rgba, target, source, source + 3);
      const keyed =
        rgbKey !== null &&
        lines[source] === rgbKey[0] &&
        lines[source + 1] === rgbKey[1] &&
        lines[source + 2] === rgbKey[2];
      rgba[target + 3] = keyed ? 0 : 255;
    } else if (colourType === 0) {
      rgba.fill(lines[source], target, target + 3);
      rgba[target + 3] = greyKey !== null && lines[source] === greyKey ? 0 : 255;
    } else if (colourType === 4) {
      rgba.fill(lines[source], target, target + 3);
      rgba[target + 3] = lines[source + 1];
    } else {
      const entry = lines[source] * 3;
      rgba[target] = palette[entry];
      rgba[target + 1] = palette[entry + 1];
      rgba[target + 2] = palette[entry + 2];
      rgba[target + 3] = transparency?.[lines[source]] ?? 255;
    }
  }

  return { width, height, data: rgba };
};

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buffer) => {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
};

const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

/** Writes straight 8-bit RGBA as a PNG, no filtering. */
export const encodePng = ({ width, height, data }) => {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.length).copy(
      raw,
      y * (width * 4 + 1) + 1,
      y * width * 4,
      (y + 1) * width * 4,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

/** Tight bounding box of pixels above an alpha threshold. */
export const opaqueBounds = (image, alphaMin = 16) => {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] < alphaMin) continue;
      count += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { count: 0, x: 0, y: 0, width: 0, height: 0 };
  return { count, x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
};
