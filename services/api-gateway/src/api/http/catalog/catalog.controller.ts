import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { auctionV1, auditV1, catalogV1, commonV1 } from '@artauction/contracts';
import type { StructuredLogger } from '@artauction/platform';
import { invoke } from '@artauction/service-kit';
import { AUCTION_CLIENT, AUDIT_CLIENT, CATALOG_CLIENT } from '../../../clients/grpc-clients';
import type { GatewayConfig } from '../../../config';
import { GATEWAY_CONFIG, GATEWAY_LOGGER } from '../tokens';
import {
  CreateLotDto,
  HashImageDto,
  ListLotsQuery,
  LotFieldsDto,
  LotVisibilityDto,
  RegisterImageDto,
  RegisterModelDto,
  SignModelUploadDto,
  SignUploadDto,
} from './catalog.dto';
import { auditJson, categoryJson, imageJson, lotJson, modelJson, REPRESENTATION_FROM_JSON, SORT_FROM_JSON } from './lot.presenter';

const VISIBILITY_FROM_JSON: Readonly<Record<'PUBLIC' | 'PRIVATE', commonV1.Visibility>> = {
  PUBLIC: commonV1.Visibility.VISIBILITY_PUBLIC,
  PRIVATE: commonV1.Visibility.VISIBILITY_PRIVATE,
};

/**
 * Rutas /lots. El catalogo es la fuente de las obras; el gateway compone el
 * resumen de subasta y el ultimo informe de auditoria. Si esos servicios no
 * responden, la obra se muestra sin ellos en lugar de fallar.
 */
@Controller('lots')
export class CatalogController {
  constructor(
    @Inject(CATALOG_CLIENT) private readonly catalog: catalogV1.CatalogServiceClient,
    @Inject(AUCTION_CLIENT) private readonly auctions: auctionV1.AuctionServiceClient,
    @Inject(AUDIT_CLIENT) private readonly audits: auditV1.AuditServiceClient,
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
    @Inject(GATEWAY_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  @Get()
  async list(@Query() query: ListLotsQuery) {
    const response = await invoke(
      this.catalog.listPublicLots.bind(this.catalog),
      catalogV1.ListPublicLotsRequest.fromPartial({
        query: query.q ?? '',
        categorySlug: query.category ?? '',
        representation: query.representation ? REPRESENTATION_FROM_JSON[query.representation] : undefined,
        sort: query.sort ? SORT_FROM_JSON[query.sort] : undefined,
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 12,
      }),
      this.options(),
    );
    const auctions = await this.auctionsFor(response.lots.map((lot) => lot.id));
    return {
      items: response.lots.map((lot) => lotJson(lot, auctions.get(lot.id))),
      total: response.pageInfo?.total ?? 0,
      page: response.pageInfo?.page ?? 1,
      pageSize: response.pageInfo?.pageSize ?? 12,
    };
  }

  /** Obras del vendedor que llama, en todos sus estados. Va antes de ':id'. */
  @Get('mine')
  async mine(@Headers('authorization') authorization: string | undefined) {
    const response = await invoke(this.catalog.listMyLots.bind(this.catalog), {}, this.options(authorization));
    const auctions = await this.auctionsFor(response.lots.map((lot) => lot.id));
    return response.lots.map((lot) => lotJson(lot, auctions.get(lot.id)));
  }

  @Get('categories')
  async categories() {
    const response = await invoke(this.catalog.listCategories.bind(this.catalog), {}, this.options());
    return response.categories.map(categoryJson);
  }

  @Get(':id/related')
  async related(@Param('id') id: string) {
    const response = await invoke(this.catalog.getRelatedLots.bind(this.catalog), { lotId: id }, this.options());
    const auctions = await this.auctionsFor(response.lots.map((lot) => lot.id));
    return response.lots.map((lot) => lotJson(lot, auctions.get(lot.id)));
  }

  @Get(':id')
  async getOne(@Param('id') id: string, @Headers('authorization') authorization: string | undefined) {
    const response = await invoke(this.catalog.getLot.bind(this.catalog), { lotId: id }, this.options(authorization));
    const lot = response.lot;
    if (!lot) {
      throw new Error('catalog-service respondio sin obra');
    }
    const [auctions, audit] = await Promise.all([this.auctionsFor([lot.id]), this.auditFor(lot.id)]);
    return { ...lotJson(lot, auctions.get(lot.id)), auditSummaries: audit };
  }

  @Post()
  async create(@Headers('authorization') authorization: string | undefined, @Body() body: CreateLotDto) {
    const response = await invoke(
      this.catalog.createLot.bind(this.catalog),
      catalogV1.CreateLotRequest.fromPartial({
        title: body.title,
        description: body.description,
        artistName: body.artistName,
        creationYear: body.creationYear,
        materials: body.materials,
        categorySlug: body.categorySlug,
        representationKind: REPRESENTATION_FROM_JSON[body.representationKind],
        widthCm: String(body.widthCm),
        heightCm: String(body.heightCm),
        depthCm: body.depthCm === undefined ? undefined : String(body.depthCm),
        provenance: body.provenance,
        destination: body.destination === 'PERSONAL' ? catalogV1.LotDestination.LOT_DESTINATION_PERSONAL : catalogV1.LotDestination.LOT_DESTINATION_CATALOG,
        visibility: body.visibility === undefined ? undefined : VISIBILITY_FROM_JSON[body.visibility],
      }),
      this.options(authorization),
    );
    if (!response.lot) {
      throw new Error('catalog-service respondio sin obra');
    }
    return lotJson(response.lot);
  }

  /** El autor muestra u oculta un proyecto propio en su galeria publica. */
  @Patch(':id/visibility')
  async visibility(@Headers('authorization') authorization: string | undefined, @Param('id') id: string, @Body() body: LotVisibilityDto) {
    const response = await invoke(
      this.catalog.setLotVisibility.bind(this.catalog),
      catalogV1.SetLotVisibilityRequest.fromPartial({ lotId: id, visibility: VISIBILITY_FROM_JSON[body.visibility] }),
      this.options(authorization),
    );
    if (!response.lot) {
      throw new Error('catalog-service respondio sin obra');
    }
    return lotJson(response.lot);
  }

  /** El autor corrige su obra en borrador (por ejemplo, tras una devolucion) o su proyecto propio. */
  @Patch(':id')
  async update(@Headers('authorization') authorization: string | undefined, @Param('id') id: string, @Body() body: LotFieldsDto) {
    const response = await invoke(
      this.catalog.updateLot.bind(this.catalog),
      catalogV1.UpdateLotRequest.fromPartial({
        lotId: id,
        title: body.title,
        description: body.description,
        artistName: body.artistName,
        creationYear: body.creationYear,
        materials: body.materials,
        categorySlug: body.categorySlug,
        representationKind: REPRESENTATION_FROM_JSON[body.representationKind],
        widthCm: String(body.widthCm),
        heightCm: String(body.heightCm),
        depthCm: body.depthCm === undefined ? undefined : String(body.depthCm),
        provenance: body.provenance,
      }),
      this.options(authorization),
    );
    if (!response.lot) {
      throw new Error('catalog-service respondio sin obra');
    }
    return lotJson(response.lot);
  }

  @Post(':id/hash')
  async hash(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: HashImageDto,
  ): Promise<{ perceptualHash: string }> {
    const response = await invoke(
      this.catalog.hashImage.bind(this.catalog),
      { lotId: id, image: Buffer.from(body.imageBase64, 'base64') },
      this.options(authorization),
    );
    return { perceptualHash: response.perceptualHash };
  }

  /** URL firmada para subir el modelo 3D (GLB) de una obra tridimensional. */
  @Post(':id/model-uploads')
  async signModel(@Headers('authorization') authorization: string | undefined, @Param('id') id: string, @Body() body: SignModelUploadDto) {
    const response = await invoke(this.catalog.signModelUpload.bind(this.catalog), { lotId: id, contentType: body.contentType }, this.options(authorization));
    const upload = response.upload;
    return { uploadUrl: upload?.uploadUrl ?? '', objectKey: upload?.objectKey ?? '', expiresAt: upload?.expiresAt?.toISOString() ?? null };
  }

  /** Registra el modelo subido: catalog lo valida y lo mide. */
  @Post(':id/model')
  async registerModel(@Headers('authorization') authorization: string | undefined, @Param('id') id: string, @Body() body: RegisterModelDto) {
    const response = await invoke(this.catalog.registerModel.bind(this.catalog), { lotId: id, objectKey: body.objectKey }, this.options(authorization));
    if (!response.model) {
      throw new Error('catalog-service respondio sin modelo');
    }
    return modelJson(response.model);
  }

  @Delete(':id/model')
  @HttpCode(204)
  async removeModel(@Headers('authorization') authorization: string | undefined, @Param('id') id: string) {
    await invoke(this.catalog.removeModel.bind(this.catalog), { lotId: id }, this.options(authorization));
  }

  @Post(':id/uploads')
  async sign(@Headers('authorization') authorization: string | undefined, @Param('id') id: string, @Body() body: SignUploadDto) {
    const response = await invoke(
      this.catalog.signUpload.bind(this.catalog),
      { lotId: id, contentType: body.contentType, position: body.position },
      this.options(authorization),
    );
    const upload = response.upload;
    return {
      uploadUrl: upload?.uploadUrl ?? '',
      objectKey: upload?.objectKey ?? '',
      expiresAt: upload?.expiresAt?.toISOString() ?? null,
    };
  }

  @Post(':id/images')
  async image(@Headers('authorization') authorization: string | undefined, @Param('id') id: string, @Body() body: RegisterImageDto) {
    const response = await invoke(
      this.catalog.registerImage.bind(this.catalog),
      { lotId: id, objectKey: body.objectKey, position: body.position, perceptualHash: body.perceptualHash },
      this.options(authorization),
    );
    if (!response.image) {
      throw new Error('catalog-service respondio sin imagen');
    }
    return imageJson(id, response.image);
  }

  @HttpCode(201)
  @Post(':id/submit')
  async submit(@Headers('authorization') authorization: string | undefined, @Param('id') id: string) {
    await invoke(this.catalog.submitLot.bind(this.catalog), { lotId: id }, this.options(authorization));
    return { status: 'PENDIENTE_AUDITORIA' as const };
  }

  private async auctionsFor(lotIds: string[]): Promise<Map<string, auctionV1.AuctionSummary>> {
    if (lotIds.length === 0) {
      return new Map();
    }
    try {
      const response = await invoke(this.auctions.batchGetAuctionSummaries.bind(this.auctions), { lotIds }, this.options());
      return new Map(response.summaries.map((summary) => [summary.lotId, summary]));
    } catch (error) {
      this.logger.warn(`sin resumen de subastas: ${error instanceof Error ? error.message : String(error)}`, 'catalog');
      return new Map();
    }
  }

  private async auditFor(lotId: string) {
    try {
      const response = await invoke(this.audits.batchGetLatestSummaries.bind(this.audits), { lotIds: [lotId] }, this.options());
      return response.summaries.map(auditJson);
    } catch (error) {
      this.logger.warn(`sin resumen de auditoria: ${error instanceof Error ? error.message : String(error)}`, 'catalog');
      return [];
    }
  }

  private options(authorization?: string) {
    return { deadlineMs: this.config.GRPC_DEADLINE_MS, authorization };
  }
}
