import sharp from 'sharp';

/**
 * dHash de 64 bits: la imagen se reduce a 9x8 en grises y cada bit indica si un
 * pixel es mas oscuro que su vecino derecho. Imagenes casi iguales dan hashes a
 * poca distancia de Hamming; sirve para detectar reutilizacion de imagenes.
 */
export async function perceptualHash(bytes: Uint8Array): Promise<string> {
  const { data, info } = await sharp(bytes, { limitInputPixels: 40_000_000 })
    .resize(9, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let bits = 0n;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = data[y * info.width + x] ?? 0;
      const right = data[y * info.width + x + 1] ?? 0;
      bits = (bits << 1n) | (left < right ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}
