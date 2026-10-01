import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Environment } from '../../common/config/environment';

export interface SignedUpload {
  uploadUrl: string;
  objectKey: string;
  expiresAt: string;
}

export interface StoragePort {
  signUpload(objectKey: string, contentType: string): SignedUpload;
}

export const STORAGE = Symbol('STORAGE');

@Injectable()
export class LocalStorageAdapter implements StoragePort {
  constructor(@Inject(ENV) private readonly env: Environment) {}

  signUpload(objectKey: string, contentType: string): SignedUpload {
    const expiresAtMs = Date.now() + this.env.GCS_SIGNED_URL_TTL_SECONDS * 1000;
    const payload = `${objectKey}\n${contentType}\n${String(expiresAtMs)}`;
    const signature = createHmac('sha256', this.env.JWT_ACCESS_SECRET).update(payload).digest('hex');
    const uploadUrl = `http://localhost:${String(this.env.PORT)}/dev-uploads?key=${encodeURIComponent(objectKey)}&exp=${String(expiresAtMs)}&sig=${signature}`;
    return { uploadUrl, objectKey, expiresAt: new Date(expiresAtMs).toISOString() };
  }
}

export function verifyLocalUpload(env: Environment, objectKey: string, contentType: string, exp: string, signature: string): boolean {
  const payload = `${objectKey}\n${contentType}\n${exp}`;
  const expected = createHmac('sha256', env.JWT_ACCESS_SECRET).update(payload).digest('hex');
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  if (left.length !== right.length || Number(exp) < Date.now()) {
    return false;
  }
  return timingSafeEqual(left, right);
}
