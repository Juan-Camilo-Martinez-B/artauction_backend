import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface MediaFetcherOptions {
  /** Hosts de los que se aceptan imagenes (proteccion contra SSRF). */
  allowedHosts: readonly string[];
  /** Base publica de Garage y su direccion interna equivalente. */
  publicMediaBase: string;
  internalMediaBase: string;
  timeoutMs: number;
  maxBytes: number;
}

/**
 * Descarga una imagen con limites estrictos: solo hosts permitidos, sin seguir
 * redirecciones, con timeout y tope de bytes, y solo respuestas image/*.
 *
 * Garage publica el bucket como http://<bucket>.web.garage.localhost:3902. Los
 * navegadores resuelven *.localhost, Node en Windows no; por eso una URL de la
 * base publica se pide a la direccion interna conservando la cabecera Host,
 * que es como Garage elige el bucket.
 */
export class MediaFetcher {
  private readonly allowed: Set<string>;
  private readonly publicBase: URL;
  private readonly internalBase: URL;

  constructor(private readonly options: MediaFetcherOptions) {
    this.allowed = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
    this.publicBase = new URL(options.publicMediaBase);
    this.internalBase = new URL(options.internalMediaBase);
    this.allowed.add(this.publicBase.hostname.toLowerCase());
  }

  async fetch(rawUrl: string): Promise<Uint8Array | null> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }
    if (!this.allowed.has(url.hostname.toLowerCase()) || url.username || url.password) {
      return null;
    }
    const isMedia = url.host === this.publicBase.host;
    if (!isMedia && url.protocol !== 'https:') {
      return null;
    }
    const target = isMedia ? new URL(`${url.pathname}${url.search}`, this.internalBase) : url;
    return this.download(target, isMedia ? this.publicBase.host : url.host);
  }

  private download(target: URL, hostHeader: string): Promise<Uint8Array | null> {
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve) => {
      const request = send(target, { method: 'GET', headers: { host: hostHeader, accept: 'image/*' }, timeout: this.options.timeoutMs }, (response: IncomingMessage) => {
        const type = response.headers['content-type'] ?? '';
        const declared = Number(response.headers['content-length'] ?? 0);
        if (response.statusCode !== 200 || !type.startsWith('image/') || declared > this.options.maxBytes) {
          response.resume();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > this.options.maxBytes) {
            request.destroy();
            resolve(null);
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          resolve(size <= this.options.maxBytes ? new Uint8Array(Buffer.concat(chunks)) : null);
        });
        response.on('error', () => {
          resolve(null);
        });
      });
      request.on('timeout', () => {
        request.destroy();
        resolve(null);
      });
      request.on('error', () => {
        resolve(null);
      });
      request.end();
    });
  }
}
