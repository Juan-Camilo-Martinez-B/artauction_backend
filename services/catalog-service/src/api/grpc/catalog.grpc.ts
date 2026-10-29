import { catalogV1, commonV1 } from '@artauction/contracts';
import type { StructuredLogger } from '@artauction/platform';
import { unary, type CallerResolver } from '@artauction/service-kit';
import type {
  CreateLot,
  HashLotImage,
  RegisterLotImage,
  ResolveManualReview,
  SignImageUpload,
  SubmitLot,
} from '../../internal/application/commands';
import type {
  BatchGetLotSnapshots,
  FindSimilarImages,
  ListReviewQueue,
  BatchGetPublicLots,
  GetLotForViewer,
  GetRelatedLots,
  ListCategories,
  ListPublicLots,
} from '../../internal/application/queries';
import { categoryToProto, decisionFromProto, imageToProto, lotToProto, representationFromProto, sortFromProto } from './mappers';

export interface CatalogUseCases {
  listPublic: ListPublicLots;
  listCategories: ListCategories;
  related: GetRelatedLots;
  getForViewer: GetLotForViewer;
  batchPublic: BatchGetPublicLots;
  batchSnapshots: BatchGetLotSnapshots;
  similarImages: FindSimilarImages;
  reviewQueue: ListReviewQueue;
  create: CreateLot;
  signUpload: SignImageUpload;
  registerImage: RegisterLotImage;
  hashImage: HashLotImage;
  submit: SubmitLot;
  resolve: ResolveManualReview;
}

/** Frontera gRPC publica del catalogo: traduce mensajes y resuelve quien llama. */
export function catalogGrpcService(
  useCases: CatalogUseCases,
  callers: CallerResolver,
  mediaBaseUrl: string,
  logger: StructuredLogger,
): catalogV1.CatalogServiceServer {
  const lot = (value: Parameters<typeof lotToProto>[0]) => lotToProto(value, mediaBaseUrl);

  return {
    listPublicLots: unary(logger, 'ListPublicLots', async (request) => {
      const page = await useCases.listPublic.execute({
        text: request.query,
        categorySlug: request.categorySlug,
        representation: representationFromProto(request.representation) ?? undefined,
        sort: sortFromProto(request.sort),
        page: request.page,
        pageSize: request.pageSize,
      });
      return catalogV1.ListPublicLotsResponse.fromPartial({
        lots: page.lots.map(lot),
        pageInfo: commonV1.PageInfo.fromPartial({ total: page.total, page: page.page, pageSize: page.pageSize }),
      });
    }),

    listCategories: unary(logger, 'ListCategories', async () =>
      catalogV1.ListCategoriesResponse.fromPartial({
        categories: (await useCases.listCategories.execute()).map(categoryToProto),
      }),
    ),

    getRelatedLots: unary(logger, 'GetRelatedLots', async (request) =>
      catalogV1.GetRelatedLotsResponse.fromPartial({ lots: (await useCases.related.execute(request.lotId)).map(lot) }),
    ),

    getLot: unary(logger, 'GetLot', async (request, context) => {
      const viewer = callers.optionalUser(context);
      const found = await useCases.getForViewer.execute(request.lotId, viewer?.userId ?? null);
      return catalogV1.GetLotResponse.fromPartial({ lot: lot(found) });
    }),

    batchGetPublicLots: unary(logger, 'BatchGetPublicLots', async (request) =>
      catalogV1.BatchGetPublicLotsResponse.fromPartial({
        lots: (await useCases.batchPublic.execute(request.lotIds)).map(lot),
      }),
    ),

    batchGetLotSnapshots: unary(logger, 'BatchGetLotSnapshots', async (request, context) => {
      callers.service(context);
      return catalogV1.BatchGetLotSnapshotsResponse.fromPartial({
        lots: (await useCases.batchSnapshots.execute(request.lotIds)).map(lot),
      });
    }),

    findSimilarImages: unary(logger, 'FindSimilarImages', async (request, context) => {
      callers.service(context, ['audit-service']);
      return catalogV1.FindSimilarImagesResponse.fromPartial({
        matches: await useCases.similarImages.execute(request.lotId, request.perceptualHashes, request.maxDistance),
      });
    }),

    createLot: unary(logger, 'CreateLot', async (request, context) => {
      const created = await useCases.create.execute(callers.user(context), {
        title: request.title,
        description: request.description,
        artistName: request.artistName,
        creationYear: request.creationYear,
        materials: request.materials,
        categorySlug: request.categorySlug,
        representationKind: representationFromProto(request.representationKind),
        widthCm: request.widthCm,
        heightCm: request.heightCm,
        depthCm: request.depthCm,
        provenance: request.provenance,
      });
      return catalogV1.CreateLotResponse.fromPartial({ lot: lot(created) });
    }),

    hashImage: unary(logger, 'HashImage', async (request, context) => {
      const perceptualHash = await useCases.hashImage.execute(callers.user(context), {
        lotId: request.lotId,
        image: request.image,
      });
      return catalogV1.HashImageResponse.fromPartial({ perceptualHash });
    }),

    signUpload: unary(logger, 'SignUpload', async (request, context) => {
      const upload = await useCases.signUpload.execute(callers.user(context), {
        lotId: request.lotId,
        contentType: request.contentType,
        position: request.position,
      });
      return catalogV1.SignUploadResponse.fromPartial({ upload });
    }),

    registerImage: unary(logger, 'RegisterImage', async (request, context) => {
      const image = await useCases.registerImage.execute(callers.user(context), {
        lotId: request.lotId,
        objectKey: request.objectKey,
        position: request.position,
        perceptualHash: request.perceptualHash,
      });
      return catalogV1.RegisterImageResponse.fromPartial({ image: imageToProto(image, mediaBaseUrl) });
    }),

    submitLot: unary(logger, 'SubmitLot', async (request, context) => {
      await useCases.submit.execute(callers.user(context), request.lotId);
      return catalogV1.SubmitLotResponse.fromPartial({ status: catalogV1.LotStatus.LOT_STATUS_PENDIENTE_AUDITORIA });
    }),

    listReviewQueue: unary(logger, 'ListReviewQueue', async (request, context) =>
      catalogV1.ListReviewQueueResponse.fromPartial({
        lots: (await useCases.reviewQueue.execute(callers.user(context), request.limit)).map(lot),
      }),
    ),

    resolveManualReview: unary(logger, 'ResolveManualReview', async (request, context) => {
      const resolved = await useCases.resolve.execute(
        callers.user(context),
        request.lotId,
        decisionFromProto(request.decision),
      );
      return catalogV1.ResolveManualReviewResponse.fromPartial({ lot: lot(resolved) });
    }),
  };
}
