import { createProxyMiddleware, type RequestHandler } from 'http-proxy-middleware';
import type { StructuredLogger } from '@artauction/platform';

/**
 * Prefijos que ya atienden los microservicios a traves del gateway. Todo lo
 * demas se reenvia al monolito (Strangler Fig). Cada fase de la migracion
 * agrega aqui sus rutas; cuando la lista cubra todo, el proxy se retira.
 */
export const MIGRATED_PREFIXES: readonly string[] = ['/auth', '/health'];

export function isMigrated(path: string, prefixes: readonly string[] = MIGRATED_PREFIXES): boolean {
  const pathname = path.split('?')[0] ?? path;
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function createLegacyProxy(target: string, logger: StructuredLogger): RequestHandler {
  return createProxyMiddleware({
    target,
    changeOrigin: false,
    xfwd: true,
    ws: true,
    pathFilter: (path) => !isMigrated(path),
    on: {
      error: (error, _request, response) => {
        logger.error(`proxy al monolito fallo: ${error.message}`, undefined, 'legacy-proxy');
        if (response instanceof Object && 'writeHead' in response && !response.headersSent) {
          response.writeHead(502, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ statusCode: 502, error: 'Bad Gateway', message: 'Servicio no disponible' }));
        }
      },
    },
  });
}
