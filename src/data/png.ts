/**
 * Minimal PNG decoder (8-bit, non-interlaced: grayscale, RGB, palette, gray+alpha, RGBA) → RGBA8.
 *
 * Used for Terrarium elevation tiles. It runs identically in browsers and Node (inflate via the standard
 * `DecompressionStream('deflate')`), and — unlike canvas decoding — never color-manages or premultiplies,
 * which would corrupt elevation values encoded in RGB.
 */

export interface DecodedPNG {
  width: number;
  height: number;
  /** RGBA8, row-major, top row first. */
  data: Uint8Array;
}

/** Largest PNG accepted, per side. Terrarium tiles are 256²; anything near this is not elevation data. */
const MAX_DIMENSION = 4096;

/**
 * Inflate with a hard output cap, reading the stream chunk by chunk instead of buffering whatever comes out. A
 * "deflate bomb" — a 300 kB IDAT that expands to hundreds of MB — is rejected at `maxOut` bytes instead of taking the
 * tab's memory with it (FINDINGS.json SEC-03). `maxOut` is what the PNG header itself promises, so a well-formed file
 * is never affected.
 */
async function inflateZlib(data: Uint8Array, maxOut: number): Promise<Uint8Array> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxOut) {
      await reader.cancel().catch(() => {});
      throw new Error('PNG data larger than its header says');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

export async function decodePNG(bytes: ArrayBuffer | Uint8Array): Promise<DecodedPNG> {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (u8[i] !== sig[i]) throw new Error('not a PNG');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= u8.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(u8[pos + 4], u8[pos + 5], u8[pos + 6], u8[pos + 7]);
    const body = u8.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(pos + 8);
      height = dv.getUint32(pos + 12);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (bitDepth ${bitDepth}, interlace ${interlace})`);
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);
  // The header decides how much output the inflate below may produce, so it has to be sane first.
  if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) throw new Error(`unsupported PNG size ${width}×${height}`);

  let total = 0;
  for (const c of idat) total += c.length;
  const z = new Uint8Array(total);
  let o = 0;
  for (const c of idat) {
    z.set(c, o);
    o += c.length;
  }
  // One filter byte per row plus the row itself: exactly what a valid PNG of this size inflates to.
  const raw = await inflateZlib(z, (width * channels + 1) * height);

  const bpp = channels;
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('truncated PNG data');
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const r = raw[src + x];
      const a = x >= bpp ? px[dst + x - bpp] : 0;
      const b = y > 0 ? px[up + x] : 0;
      const c = x >= bpp && y > 0 ? px[up + x - bpp] : 0;
      let v: number;
      switch (ft) {
        case 0:
          v = r;
          break;
        case 1:
          v = r + a;
          break;
        case 2:
          v = r + b;
          break;
        case 3:
          v = r + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = r + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`bad PNG filter ${ft}`);
      }
      px[dst + x] = v & 255;
    }
  }

  const out = new Uint8Array(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * channels;
    const d = i * 4;
    switch (colorType) {
      case 0:
        out[d] = out[d + 1] = out[d + 2] = px[s];
        out[d + 3] = 255;
        break;
      case 2:
        out[d] = px[s];
        out[d + 1] = px[s + 1];
        out[d + 2] = px[s + 2];
        out[d + 3] = 255;
        break;
      case 3: {
        const k = px[s];
        out[d] = palette ? palette[k * 3] : 0;
        out[d + 1] = palette ? palette[k * 3 + 1] : 0;
        out[d + 2] = palette ? palette[k * 3 + 2] : 0;
        out[d + 3] = trns && k < trns.length ? trns[k] : 255;
        break;
      }
      case 4:
        out[d] = out[d + 1] = out[d + 2] = px[s];
        out[d + 3] = px[s + 1];
        break;
      case 6:
        out[d] = px[s];
        out[d + 1] = px[s + 1];
        out[d + 2] = px[s + 2];
        out[d + 3] = px[s + 3];
        break;
    }
  }
  return { width, height, data: out };
}
