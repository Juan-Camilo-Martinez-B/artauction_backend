import exifr from 'exifr';
import sharp, { type Sharp } from 'sharp';
import { generatorMarker, type ImageMetrics } from '../domain/dossier';
import type { ImageAnalyzer } from '../application/ports';
import type { MediaFetcher } from './media-fetcher';

const MAX_INPUT_PIXELS = 40_000_000;
const SAMPLE_SIDE = 512;
const LAPLACIAN = { width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0], offset: 128 };

function text(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 120) : null;
  }
  return null;
}

function hex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
}

/** Varianza del Laplaciano sobre una muestra en grises; el offset 128 conserva el signo. */
async function sharpness(image: Sharp): Promise<number> {
  const { data } = await image
    .clone()
    .resize(SAMPLE_SIDE, SAMPLE_SIDE, { fit: 'inside', withoutEnlargement: true })
    .grayscale()
    .convolve(LAPLACIAN)
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  let squares = 0;
  for (const value of data) {
    const centered = value - 128;
    sum += centered;
    squares += centered * centered;
  }
  const mean = sum / data.length;
  return squares / data.length - mean * mean;
}

/** Saturacion media (max - min) / max sobre una muestra de 64x64. */
async function saturation(image: Sharp): Promise<number> {
  const { data, info } = await image.clone().resize(64, 64, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let total = 0;
  const pixels = data.length / info.channels;
  for (let index = 0; index < data.length; index += info.channels) {
    const red = data[index] ?? 0;
    const green = data[index + 1] ?? red;
    const blue = data[index + 2] ?? red;
    const max = Math.max(red, green, blue);
    total += max === 0 ? 0 : (max - Math.min(red, green, blue)) / max;
  }
  return pixels === 0 ? 0 : total / pixels;
}

/**
 * Mide una imagen sin enviarla a ningun modelo: dimensiones, nitidez,
 * entropia, saturacion, color dominante y metadatos EXIF/XMP/IPTC.
 */
export class SharpImageAnalyzer implements ImageAnalyzer {
  constructor(private readonly fetcher: MediaFetcher) {}

  async analyze(url: string): Promise<ImageMetrics | null> {
    const bytes = await this.fetcher.fetch(url);
    if (!bytes) {
      return null;
    }
    try {
      const image = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS });
      const [metadata, stats, laplacianVariance, meanSaturation, tags] = await Promise.all([
        image.metadata(),
        image.stats(),
        sharpness(image),
        saturation(image),
        exifr.parse(bytes, { tiff: true, exif: true, xmp: true, iptc: true }).catch(() => null) as Promise<Record<string, unknown> | null>,
      ]);
      if (!metadata.width || !metadata.height) {
        return null;
      }
      const entropy = stats.entropy;
      const make = text(tags?.['Make']);
      const model = text(tags?.['Model']);
      const software = text(tags?.['Software']) ?? text(tags?.['CreatorTool']);
      const taken = tags?.['DateTimeOriginal'] ?? tags?.['CreateDate'];
      return {
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
        bytes: bytes.length,
        sharpness: laplacianVariance,
        entropy,
        saturation: meanSaturation,
        dominantColor: `#${hex(stats.dominant.r)}${hex(stats.dominant.g)}${hex(stats.dominant.b)}`,
        exif: {
          software,
          camera: [make, model].filter((part): part is string => part !== null).join(' ') || null,
          takenAt: taken instanceof Date ? taken.toISOString() : text(taken),
          generatorMarker: generatorMarker([software, text(tags?.['Credit']), text(tags?.['Description']), tags ? JSON.stringify(tags).slice(0, 4_000) : null]),
        },
      };
    } catch {
      return null;
    }
  }
}
