import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { thumbnail } from '../src/eval-smoke.js';

describe('thumbnail', () => {
  it('downscales a JPEG and keeps the aspect ratio and colour', () => {
    const w = 768, h = 1024, data = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) { data[i * 4] = 20; data[i * 4 + 1] = 40; data[i * 4 + 2] = 120; data[i * 4 + 3] = 255; }
    const src = Buffer.from(jpeg.encode({ data, width: w, height: h }, 90).data);
    const out = jpeg.decode(thumbnail(src, 256), { useTArray: true });
    expect([out.width, out.height]).toEqual([256, 341]);
    const [r, g, b] = [out.data[0]!, out.data[1]!, out.data[2]!];
    expect(Math.abs(r - 20)).toBeLessThan(8);
    expect(Math.abs(g - 40)).toBeLessThan(8);
    expect(Math.abs(b - 120)).toBeLessThan(8);
  });
});
