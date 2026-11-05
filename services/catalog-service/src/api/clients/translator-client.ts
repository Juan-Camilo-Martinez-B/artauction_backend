import { aiV1 } from '@artauction/contracts';
import { invoke, type ServiceTokenProvider } from '@artauction/service-kit';
import type { LotTranslator, TranslatedTexts } from '../../internal/application/ports';
import { isLocale, type TranslatableTexts } from '../../internal/domain/translation';

/** La primera traduccion de cada direccion carga el modelo en ai-service. */
const DEADLINE_MS = 240_000;

function textsOf(texts: aiV1.LotTexts | undefined): TranslatableTexts {
  if (!texts) {
    throw new Error('ai-service devolvio una traduccion sin textos');
  }
  return { title: texts.title, description: texts.description, materials: texts.materials, provenance: texts.provenance ?? null };
}

/** Traductor de fichas de ai-service (TranslateLot), con el token de servicio de catalog. */
export class GrpcLotTranslator implements LotTranslator {
  constructor(
    private readonly ai: aiV1.AiServiceClient,
    private readonly tokens: ServiceTokenProvider,
  ) {}

  async translate(texts: TranslatableTexts): Promise<TranslatedTexts> {
    const response = await invoke(
      this.ai.translateLot.bind(this.ai),
      aiV1.TranslateLotRequest.fromPartial({
        texts: { title: texts.title, description: texts.description, materials: texts.materials, provenance: texts.provenance ?? undefined },
      }),
      { deadlineMs: DEADLINE_MS, authorization: await this.tokens.authorization() },
    );
    if (!isLocale(response.sourceLocale)) {
      throw new Error(`ai-service devolvio un idioma desconocido: ${response.sourceLocale}`);
    }
    return {
      sourceLocale: response.sourceLocale,
      model: response.model,
      translations: response.translations.flatMap((translation) =>
        isLocale(translation.locale) ? [{ locale: translation.locale, texts: textsOf(translation.texts) }] : [],
      ),
    };
  }
}
