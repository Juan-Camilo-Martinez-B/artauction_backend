import { DomainError } from '@artauction/platform';
import { lotCreated, lotPublished, lotSubmitted } from '../domain/events';
import {
  assertCanSell,
  assertOwnedAndOpen,
  parseNewLot,
  publicImageUrl,
  type Actor,
  type Lot,
  type LotImage,
  type RepresentationKind,
} from '../domain/lot';
import { assertTransition } from '../domain/lot-status';
import type { ImageHasher, LotRepository, SignedUpload, TokenSource, UploadSigner } from './ports';

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
    },
  ): Promise<Lot> {
    assertCanSell(actor);
    const lot = parseNewLot(input);
    const category = await this.lots.findActiveCategory(lot.categorySlug);
    if (!category) {
      throw DomainError.invalid('La categoria no existe.');
    }
    return this.lots.create(actor.userId, lot, category.id, (created) => [lotCreated(created)]);
  }
}

export class SignImageUpload {
  constructor(
    private readonly lots: LotRepository,
    private readonly signer: UploadSigner,
    private readonly tokens: TokenSource,
  ) {}

  async execute(actor: Actor, input: { lotId: string; contentType: string; position: number }): Promise<SignedUpload> {
    assertCanSell(actor);
    assertOwnedAndOpen(await this.lots.findById(input.lotId), actor);
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
    assertCanSell(actor);
    assertOwnedAndOpen(await this.lots.findById(input.lotId), actor);
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

export class HashLotImage {
  constructor(
    private readonly lots: LotRepository,
    private readonly hasher: ImageHasher,
  ) {}

  async execute(actor: Actor, input: { lotId: string; image: Uint8Array }): Promise<string> {
    assertCanSell(actor);
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
    assertCanSell(actor);
    const lot = assertOwnedAndOpen(await this.lots.findById(lotId), actor);
    assertTransition(lot.status, 'PENDIENTE_AUDITORIA');
    const updated = await this.lots.transition(lotId, lot.status, 'PENDIENTE_AUDITORIA', {}, () => [lotSubmitted(lotId)]);
    if (!updated) {
      throw DomainError.conflict('La obra cambio mientras se enviaba. Intenta de nuevo.');
    }
    return 'PENDIENTE_AUDITORIA';
  }
}

export type ReviewDecision = 'APPROVE' | 'RETURN_TO_DRAFT';

/** Revision manual de un administrador: publica la obra o la devuelve a borrador. */
export class ResolveManualReview {
  constructor(private readonly lots: LotRepository) {}

  async execute(actor: Actor, lotId: string, decision: ReviewDecision): Promise<Lot> {
    if (actor.role !== 'ADMIN') {
      throw DomainError.forbidden('Solo un administrador resuelve revisiones');
    }
    const lot = await this.lots.findById(lotId);
    if (!lot) {
      throw DomainError.notFound('Obra no encontrada');
    }
    const to = decision === 'APPROVE' ? 'PUBLICADA' : 'BORRADOR';
    assertTransition(lot.status, to);
    const updated = await this.lots.transition(
      lotId,
      lot.status,
      to,
      { visibility: to === 'PUBLICADA' ? 'PUBLIC' : 'PRIVATE' },
      (next) => (to === 'PUBLICADA' ? [lotPublished(next)] : []),
    );
    if (!updated) {
      throw DomainError.conflict('La obra cambio mientras se resolvia. Intenta de nuevo.');
    }
    return updated;
  }
}

function assertPosition(position: number): void {
  if (!Number.isInteger(position) || position < 0 || position > MAX_POSITION) {
    throw DomainError.invalid('La posicion de la imagen no es valida.');
  }
}
