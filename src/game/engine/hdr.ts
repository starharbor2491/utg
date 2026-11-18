import {
  ADDRESS_CLAMP_TO_EDGE,
  ADDRESS_REPEAT,
  FILTER_NEAREST,
  PIXELFORMAT_RGBA8,
  TEXTUREPROJECTION_EQUIRECT,
  TEXTURETYPE_RGBE,
  Texture,
} from 'playcanvas';
import type { GraphicsDevice } from 'playcanvas';

/**
 * Radiance .hdr (RGBE) loader. PlayCanvas has no .hdr parser, but its env-lighting tools read
 * RGBE textures directly, so the scanlines are decoded only as far as their stored RGBE bytes.
 */
export function parseRadianceHdr(buffer: ArrayBuffer): { width: number; height: number; rgbe: Uint8Array } {
  const bytes = new Uint8Array(buffer);
  let pos = 0;
  const readLine = (): string => {
    let s = '';
    while (pos < bytes.length && bytes[pos] !== 0x0a) s += String.fromCharCode(bytes[pos++]);
    pos++;
    return s;
  };
  const magic = readLine();
  if (!magic.startsWith('#?')) throw new Error('Not a Radiance HDR file');
  let line: string;
  while ((line = readLine()) !== '') {
    if (line.startsWith('FORMAT=') && !line.includes('32-bit_rle_rgbe')) throw new Error(`Unsupported HDR format ${line}`);
  }
  const size = /^-Y (\d+) \+X (\d+)$/.exec(readLine());
  if (!size) throw new Error('Unsupported HDR orientation');
  const height = +size[1], width = +size[2];
  const rgbe = new Uint8Array(width * height * 4);
  const scan = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    const row = rgbe.subarray(y * width * 4, (y + 1) * width * 4);
    if (width < 8 || width > 0x7fff || bytes[pos] !== 2 || bytes[pos + 1] !== 2 || (bytes[pos + 2] & 0x80)) {
      // Flat (uncompressed) scanlines.
      row.set(bytes.subarray(pos, pos + width * 4));
      pos += width * 4;
      continue;
    }
    if (((bytes[pos + 2] << 8) | bytes[pos + 3]) !== width) throw new Error('Bad HDR scanline width');
    pos += 4;
    for (let c = 0; c < 4; c++) {
      let x = 0;
      while (x < width) {
        let count = bytes[pos++];
        if (count > 128) {
          count -= 128;
          const v = bytes[pos++];
          for (let k = 0; k < count; k++) scan[(x++) * 4 + c] = v;
        } else {
          for (let k = 0; k < count; k++) scan[(x++) * 4 + c] = bytes[pos++];
        }
      }
    }
    row.set(scan);
  }
  return { width, height, rgbe };
}

/** Equirect RGBE texture suitable for EnvLighting.generateSkyboxCubemap / generateLightingSource. */
export function createHdrTexture(device: GraphicsDevice, buffer: ArrayBuffer, name = 'hdr'): Texture {
  const { width, height, rgbe } = parseRadianceHdr(buffer);
  const tex = new Texture(device, {
    name,
    width,
    height,
    format: PIXELFORMAT_RGBA8,
    type: TEXTURETYPE_RGBE,
    projection: TEXTUREPROJECTION_EQUIRECT,
    mipmaps: false,
    // RGBE must not be filtered before decoding.
    minFilter: FILTER_NEAREST,
    magFilter: FILTER_NEAREST,
    addressU: ADDRESS_REPEAT,
    addressV: ADDRESS_CLAMP_TO_EDGE,
    levels: [rgbe],
  });
  return tex;
}
