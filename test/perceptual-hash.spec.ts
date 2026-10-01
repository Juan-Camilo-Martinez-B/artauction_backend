import sharp from 'sharp';
import { perceptualHash } from '../src/infra/workers/perceptual-hash';

describe('hash perceptual', () => {
  it('resume una imagen en 64 bits', async () => {
    const png = await sharp({
      create: { width: 16, height: 16, channels: 3, background: { r: 10, g: 10, b: 10 } },
    })
      .png()
      .toBuffer();
    await expect(perceptualHash(png)).resolves.toMatch(/^[0-9a-f]{16}$/);
  });
});
