import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { aiV1 } from '@artauction/contracts';
import { StructuredLogger, TokenVerifier } from '@artauction/platform';
import { CallerResolver } from '@artauction/service-kit';
import { aiGrpcService } from './api/grpc/ai.grpc';
import type { LanguageModel } from './internal/application/ports';
import { AuditArtwork, DesignGallery } from './internal/application/use-cases';
import { GeminiModel } from './internal/infrastructure/gemini-model';
import type { AiConfig } from './config';

// Raiz de composicion de ai-service: sin base de datos ni clientes de otros
// servicios. Solo verifica quien llama y habla con el modelo.

export const LOGGER = Symbol('LOGGER');
export const AI_GRPC = Symbol('AI_GRPC');
const CONFIG = Symbol('CONFIG');
const MODEL = Symbol('MODEL');

const providers: Provider[] = [
  { provide: LOGGER, useValue: new StructuredLogger('ai-service') },
  {
    provide: MODEL,
    inject: [CONFIG, LOGGER],
    useFactory: (config: AiConfig, logger: StructuredLogger): LanguageModel | null => {
      if (!config.geminiConfigured) {
        logger.warn('GEMINI_API_KEY vacia: la auditoria usa la evaluacion local y DesignGallery no esta disponible', 'ai');
        return null;
      }
      return new GeminiModel({ apiKey: config.GEMINI_API_KEY, model: config.GEMINI_MODEL, timeoutMs: config.GEMINI_TIMEOUT_MS });
    },
  },
  {
    provide: AI_GRPC,
    inject: [CONFIG, MODEL, LOGGER],
    useFactory: (config: AiConfig, model: LanguageModel | null, logger: StructuredLogger): aiV1.AiServiceServer =>
      aiGrpcService(
        { audit: new AuditArtwork(model), design: new DesignGallery(model) },
        new CallerResolver(TokenVerifier.fromFile(config.JWT_PUBLIC_KEY_PATH)),
        logger,
      ),
  },
];

@Module({})
export class AiModule {
  static register(config: AiConfig): DynamicModule {
    return {
      module: AiModule,
      providers: [{ provide: CONFIG, useValue: config }, ...providers],
      exports: [LOGGER, AI_GRPC],
    };
  }
}
