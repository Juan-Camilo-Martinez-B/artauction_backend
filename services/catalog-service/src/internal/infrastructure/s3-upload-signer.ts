import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { SignedUpload, UploadSigner } from '../application/ports';

export interface S3Settings {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresInSeconds: number;
}

/**
 * Firma URLs prefirmadas (SigV4) para que el navegador suba la imagen directo
 * al bucket, sin pasar por el backend. Funciona con cualquier servicio S3:
 * Garage en local, AWS S3 o la interoperabilidad S3 de Cloud Storage.
 */
export class S3UploadSigner implements UploadSigner {
  private readonly client: S3Client;

  constructor(private readonly settings: S3Settings) {
    this.client = new S3Client({
      endpoint: settings.endpoint,
      region: settings.region,
      forcePathStyle: true,
      credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
      // Por defecto el SDK firma un checksum CRC32 del cuerpo en la URL; al
      // prefirmar no conoce el archivo y firmaria el de un cuerpo vacio, asi que
      // el servidor rechazaria la imagen real. Solo cuando la operacion lo exige.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async sign(objectKey: string, contentType: string): Promise<SignedUpload> {
    const command = new PutObjectCommand({ Bucket: this.settings.bucket, Key: objectKey, ContentType: contentType });
    const uploadUrl = await getSignedUrl(this.client, command, {
      expiresIn: this.settings.expiresInSeconds,
      // El navegador debe enviar el mismo Content-Type que se firmo.
      signableHeaders: new Set(['content-type']),
    });
    return { uploadUrl, objectKey, expiresAt: new Date(Date.now() + this.settings.expiresInSeconds * 1000) };
  }
}
