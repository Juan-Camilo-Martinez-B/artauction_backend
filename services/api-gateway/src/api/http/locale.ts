import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Idiomas de la interfaz y de las fichas traducidas. */
export const LOCALES = ['es', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'es';

function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/**
 * Idioma preferido segun Accept-Language (RFC 9110): el de mayor peso q entre
 * los que la plataforma ofrece, mirando solo la etiqueta principal ("en-US"
 * cuenta como "en"). Si ninguno sirve, espanol.
 */
export function parseAcceptLanguage(header: string | undefined): Locale {
  if (!header) {
    return DEFAULT_LOCALE;
  }
  let best: { locale: Locale; quality: number } | null = null;
  for (const entry of header.split(',').slice(0, 20)) {
    const [tag = '', ...params] = entry.trim().split(';');
    const primary = tag.trim().toLowerCase().split('-')[0] ?? '';
    if (!isLocale(primary)) {
      continue;
    }
    const qParam = params.map((param) => param.trim()).find((param) => param.startsWith('q='));
    const quality = qParam ? Number(qParam.slice(2)) : 1;
    if (Number.isFinite(quality) && quality > 0 && (!best || quality > best.quality)) {
      best = { locale: primary, quality };
    }
  }
  return best?.locale ?? DEFAULT_LOCALE;
}

/** Idioma en que el cliente pide las fichas, tomado de Accept-Language. */
export const RequestLocale = createParamDecorator((_data: unknown, context: ExecutionContext): Locale => {
  const request = context.switchToHttp().getRequest<Request>();
  return parseAcceptLanguage(request.headers['accept-language']);
});
