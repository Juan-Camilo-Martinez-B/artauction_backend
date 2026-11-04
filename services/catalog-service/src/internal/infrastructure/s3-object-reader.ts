import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DomainError } from '@artauction/platform';
import type { ModelReader } from '../application/ports';
import type { S3Settings } from './s3-upload-signer';

/**
 * Lee un archivo del bucket para validarlo (el modelo 3D que subio el
 * navegador). Corta la lectura en `maxBytes`: un archivo mas grande no se
 * descarga entero ni ocupa la memoria del servicio.
 */
export class S3ObjectReader implements ModelReader {
  private readonly client: S3Client;

  constructor(private readonly settings: Omit<S3Settings, 'expiresInSeconds'>) {
    this.client = new S3Client({
      endpoint: settings.endpoint,
      region: settings.region,
      forcePathStyle: true,
      credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async read(objectKey: string, maxBytes: number): Promise<Uint8Array> {
    let response;
    try {
      response = await this.client.send(new GetObjectCommand({ Bucket: this.settings.bucket, Key: objectKey }));
    } catch {
      throw DomainError.invalid('No encontramos el archivo subido. Vuelve a subir el modelo.');
    }
    if (response.ContentLength !== undefined && response.ContentLength > maxBytes) {
      throw DomainError.invalid('El modelo 3D pesa mas de 30 MB.');
    }
    const body = response.Body as AsyncIterable<Uint8Array> | undefined;
    if (!body) {
      throw DomainError.invalid('El archivo subido esta vacio.');
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of body) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw DomainError.invalid('El modelo 3D pesa mas de 30 MB.');
      }
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
}
