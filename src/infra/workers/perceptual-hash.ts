import sharp from 'sharp';

export async function perceptualHash(bytes: Buffer): Promise<string> {
  const { data, info } = await sharp(bytes).resize(9, 8, { fit: 'fill' }).grayscale().raw().toBuffer({
    resolveWithObject: true,
  });
  let bits = '';
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = data[y * info.width + x] ?? 0;
      const right = data[y * info.width + x + 1] ?? 0;
      bits += left < right ? '1' : '0';
    }
  }
  return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
}
