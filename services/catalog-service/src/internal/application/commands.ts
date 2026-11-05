import { DomainError } from '@artauction/platform';
import { lotCreated, lotPublished, lotReturnedToDraft, lotSubmitted, lotVisibilityChanged } from '../domain/events';
import { inspectGlb, MODEL_LIMITS } from '../domain/glb';
import {
  assertAcceptsModel,
  assertCanCreate,
  assertCanSell,
  assertEditable,
  assertOwnedAndOpen,
  assertPersonal,
  assertShowable,
  initialState,
  modelKeyPattern,
  parseNewLot,
  publicImageUrl,
  type Actor,
  type Lot,
  type LotDestination,
  type LotImage,
  type LotModel,
  type RepresentationKind,
  type Visibility,
} from '../domain/lot';
import { assertTransition } from '../domain/lot-status';
import { planReview, type ReviewDecision } from '../domain/review';
import type { ImageHasher, LotRepository, ModelReader, SignedUpload, TokenSource, UploadSigner } from './ports';

const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_POSITION = 20;

export class CreateLot {
  constructor(private readonly lots: LotRepository) {}

  async execute(
    actor: Actor,
    input: {
      title: string;
      description: string;
      artistName?: string | null;
      creationYear?: number | null;
      materials: string;
      categorySlug: string;
      representationKind: RepresentationKind | null;
      widthCm: string;
      heightCm: string;
      depthCm?: string | null;
      provenance?: string | null;
      /** Sin destino se publica al catalogo, como antes de los proyectos propios. */
      destination?: LotDestination;
      visibility?: Visibility | null;
    },
  ): Promise<Lot> {
    const destination = input.destination ?? 'CATALOG';
    assertCanCreate(actor, destination);
    const lot = parseNewLot(input);
    const category = await this.lots.findActiveCategory(lot.categorySlug);
    if (!category) {
      throw DomainError.invalid('La categoria no existe.');
    }
    return this.lots.create(actor.userId, lot, category.id, initialState(destination, input.visibility ?? null, lot.representationKind), (created) => [lotCreated(created)]);
  }
}

type LotInput = Parameters<typeof parseNewLot>[0];

/**
 * El autor corrige la ficha de su obra en borrador (por ejemplo, tras una
 * devolucion) o de un proyecto propio. Basta con ser el autor: un proyecto
 * propio puede ser de una cuenta que no vende.
 */
export class UpdateLot {
  constructor(private readonly lots: LotRepository) {}

  async execute(actor: Actor, lotId: string, input: LotInput): Promise<Lot> {
    assertEditable(await this.lots.findById(lotId), actor);
    const lot = parseNewLot(input);
    const category = await this.lots.findActiveCategory(lot.categorySlug);
    if (!category) {
      throw DomainError.invalid('La categoria no existe.');
    }
    const updated = await this.lots.update(lotId, lot, category.id);
    if (!updated) {
      throw DomainError.conflict('La obra cambio mientras se editaba. Intenta de nuevo.', { code: 'LOT_CHANGED' });
    }
    return updated;
  }
}

export class SignImageUpload {
  constructor(
    private readonly lots: LotRepository,
    private readonly signer: UploadSigner,
    private readonly tokens: TokenSource,
  ) {}

  async execute(actor: Actor, input: { lotId: string; contentType: string; position: number }): Promise<SignedUpload> {
    assertEditable(await this.lots.findById(input.lotId), actor);
    if (!ALLOWED_CONTENT_TYPES.has(input.contentType)) {
      throw DomainError.invalid('Formato de imagen no admitido.');
    }
    assertPosition(input.position);
    // Clave nueva en cada subida: reemplazar la imagen no queda oculto por caches.
    const objectKey = `${lotKeyPrefix(input.lotId)}${String(input.position)}-${this.tokens.next()}`;
    return this.signer.sign(objectKey, input.contentType);
  }
}

/** Las imagenes subidas de una obra viven bajo este prefijo del bucket. */
export function lotKeyPrefix(lotId: string): string {
  return `lots/${lotId}/`;
}

export class RegisterLotImage {
  constructor(private readonly lots: LotRepository) {}

  async execute(
    actor: Actor,
    input: { lotId: string; objectKey: string; position: number; perceptualHash?: string | null },
  ): Promise<LotImage> {
    assertEditable(await this.lots.findById(input.lotId), actor);
    assertPosition(input.position);
    const objectKey = input.objectKey.trim();
    // Solo una clave subida para esta obra o una URL https publica: una obra no
    // puede apropiarse de la imagen de otra.
    const ownKey = objectKey.startsWith(lotKeyPrefix(input.lotId)) && /^[\w./-]+$/.test(objectKey);
    if (objectKey.length > 1000 || (!ownKey && publicImageUrl(objectKey) === null)) {
      throw DomainError.invalid('La clave de la imagen no es valida.');
    }
    const hash = input.perceptualHash?.trim() || null;
    if (hash !== null && !/^[0-9a-f]{16}$/.test(hash)) {
      throw DomainError.invalid('El hash perceptual no es valido.');
    }
    return this.lots.upsertImage(input.lotId, { objectKey, position: input.position, perceptualHash: hash });
  }
}

const MODEL_CONTENT_TYPE = 'model/gltf-binary';

/**
 * URL firmada para que el navegador suba el modelo 3D (GLB) directo al bucket.
 * Como la ficha y la imagen, solo en borrador o en un proyecto propio: una obra
 * auditada no cambia de modelo sin volver a auditarse.
 */
export class SignModelUpload {
  constructor(
    private readonly lots: LotRepository,
    private readonly signer: UploadSigner,
    private readonly tokens: TokenSource,
  ) {}

  async execute(actor: Actor, input: { lotId: string; contentType: string }): Promise<SignedUpload> {
    const lot = assertEditable(await this.lots.findById(input.lotId), actor);
    assertAcceptsModel(lot);
    if (input.contentType !== MODEL_CONTENT_TYPE) {
      throw DomainError.invalid('El modelo 3D debe ser un archivo .glb.');
    }
    return this.signer.sign(`${lotKeyPrefix(lot.id)}model-${this.tokens.next()}.glb`, MODEL_CONTENT_TYPE);
  }
}

/**
 * Registra el modelo ya subido: lo lee del bucket, lo valida y lo mide (formato,
 * archivos externos, triangulos y caja). Solo se guarda lo que paso la
 * validacion; los triangulos son evidencia para la auditoria, no precio.
 */
export class RegisterLotModel {
  constructor(
    private readonly lots: LotRepository,
    private readonly reader: ModelReader,
  ) {}

  async execute(actor: Actor, input: { lotId: string; objectKey: string }): Promise<LotModel> {
    const lot = assertEditable(await this.lots.findById(input.lotId), actor);
    assertAcceptsModel(lot);
    const objectKey = input.objectKey.trim();
    // Solo una clave firmada para esta obra: una obra no se apropia del modelo de otra.
    if (!modelKeyPattern(lot.id).test(objectKey)) {
      throw DomainError.invalid('La clave del modelo no es valida.');
    }
    const file = await this.reader.read(objectKey, MODEL_LIMITS.maxBytes);
    const report = inspectGlb(file);
    return this.lots.saveModel(lot.id, {
      objectKey,
      bytes: file.byteLength,
      triangleCount: report.triangles,
      vertexCount: report.vertices,
      sizeX: report.size.x,
      sizeY: report.size.y,
      sizeZ: report.size.z,
    });
  }
}

/** El autor quita el modelo de su obra en borrador o proyecto propio. */
export class RemoveLotModel {
  constructor(private readonly lots: LotRepository) {}

  async execute(actor: Actor, lotId: string): Promise<void> {
    const lot = assertEditable(await this.lots.findById(lotId), actor);
    // Un proyecto propio publico no se queda sin modelo: se reemplaza subiendo otro.
    if (lot.visibility === 'PUBLIC' && lot.representationKind === 'THREE_D') {
      throw DomainError.precondition('Tu obra es publica: sube otro modelo para reemplazarlo u ocultala antes de quitarlo.', { code: 'MODEL_REMOVE_PUBLIC' });
    }
    await this.lots.removeModel(lot.id);
  }
}

export class HashLotImage {
  constructor(
    private readonly lots: LotRepository,
    private readonly hasher: ImageHasher,
  ) {}

  async execute(actor: Actor, input: { lotId: string; image: Uint8Array }): Promise<string> {
    assertOwnedAndOpen(await this.lots.findById(input.lotId), actor);
    if (input.image.byteLength < 8 || input.image.byteLength > MAX_IMAGE_BYTES) {
      throw DomainError.invalid('La imagen esta vacia o supera 8 MB.');
    }
    try {
      return await this.hasher.hash(input.image);
    } catch {
      throw DomainError.invalid('No se pudo leer la imagen.');
    }
  }
}

export class SubmitLot {
  constructor(private readonly lots: LotRepository) {}

  async execute(actor: Actor, lotId: string): Promise<'PENDIENTE_AUDITORIA'> {
    // Pasar al catalogo, tambien un proyecto propio, es cosa de quien vende.
    assertCanSell(actor);
    const lot = assertOwnedAndOpen(await this.lots.findById(lotId), actor);
    assertTransition(lot.status, 'PENDIENTE_AUDITORIA');
    assertShowable(lot);
    // Un proyecto propio publico se oculta mientras se audita: lo publica la auditoria.
    const updated = await this.lots.transition(lotId, lot.status, 'PENDIENTE_AUDITORIA', { visibility: 'PRIVATE' }, () => [lotSubmitted(lotId)]);
    if (!updated) {
      throw DomainError.conflict('La obra cambio mientras se enviaba. Intenta de nuevo.', { code: 'LOT_CHANGED' });
    }
    return 'PENDIENTE_AUDITORIA';
  }
}

/** El autor muestra u oculta un proyecto propio en su galeria publica. */
export class SetLotVisibility {
  constructor(private readonly lots: LotRepository) {}

  async execute(actor: Actor, lotId: string, visibility: Visibility): Promise<Lot> {
    const lot = assertPersonal(await this.lots.findById(lotId), actor);
    if (lot.visibility === visibility) {
      return lot;
    }
    if (visibility === 'PUBLIC') {
      assertShowable(lot);
    }
    // Mismo estado de origen y destino: el control optimista evita pisar un envio al catalogo.
    const updated = await this.lots.transition(lotId, 'PERSONAL', 'PERSONAL', { visibility }, (changed) => [lotVisibilityChanged(changed)]);
    if (!updated) {
      throw DomainError.conflict('La obra cambio mientras se actualizaba. Intenta de nuevo.', { code: 'LOT_CHANGED' });
    }
    return updated;
  }
}

export type { ReviewDecision };

/**
 * Revision manual de un administrador: publica la obra (con el rango de precio
 * que fije si la auditoria no lo estimo), la devuelve a borrador con un motivo
 * que recibe el vendedor, o pide otra auditoria. La decision queda en el
 * historial, en la misma transaccion que el cambio de estado.
 */
export class ResolveManualReview {
  constructor(private readonly lots: LotRepository) {}

  async execute(
    actor: Actor,
    lotId: string,
    input: { decision: ReviewDecision; reason?: string | null; priceMin?: number | null; priceMax?: number | null },
  ): Promise<Lot> {
    if (actor.role !== 'ADMIN') {
      throw DomainError.forbidden('Solo un administrador resuelve revisiones', { code: 'ADMIN_ONLY' });
    }
    const lot = await this.lots.findById(lotId);
    if (!lot) {
      throw DomainError.notFound('Obra no encontrada', { code: 'LOT_NOT_FOUND' });
    }
    const plan = planReview(lot, input);
    assertTransition(lot.status, plan.to);
    const patch =
      plan.to === 'PUBLICADA'
        ? {
            visibility: 'PUBLIC' as const,
            ...(plan.priceMin !== null && plan.priceMax !== null
              ? { suggestedPriceMin: plan.priceMin.toFixed(2), suggestedPriceMax: plan.priceMax.toFixed(2) }
              : {}),
          }
        : { visibility: 'PRIVATE' as const };
    const updated = await this.lots.transition(
      lotId,
      lot.status,
      plan.to,
      patch,
      (next) => {
        if (plan.decision === 'APPROVE') {
          return [lotPublished(next)];
        }
        if (plan.decision === 'RETURN_TO_DRAFT') {
          return [lotReturnedToDraft(next, plan.reason ?? '')];
        }
        return [lotSubmitted(lotId)];
      },
      { adminId: actor.userId, decision: plan.decision, reason: plan.reason, priceMin: plan.priceMin, priceMax: plan.priceMax },
    );
    if (!updated) {
      throw DomainError.conflict('La obra cambio mientras se resolvia. Intenta de nuevo.', { code: 'LOT_CHANGED' });
    }
    return updated;
  }
}

function assertPosition(position: number): void {
  if (!Number.isInteger(position) || position < 0 || position > MAX_POSITION) {
    throw DomainError.invalid('La posicion de la imagen no es valida.');
  }
}
