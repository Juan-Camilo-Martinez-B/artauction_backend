import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { canTransition } from '../../common/domain/lot-state';
import { canViewLot } from '../../common/domain/visibility';
import { GALLERY_GRANTS, type GalleryGrants } from '../../common/outcomes';
import { PrismaService } from '../../infra/postgres/prisma.service';
import { AuditQueue } from '../../infra/queue/audit-queue';
import { STORAGE, type StoragePort } from '../../infra/storage/storage.port';
import { ImageHashPool } from '../../infra/workers/image-hash.pool';
import type { CreateLotDto, RegisterImageDto } from './dto';

const PUBLIC_STATUSES = ['APROBADO', 'EN_SUBASTA', 'CERRADO'];

@Injectable()
export class CatalogoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audits: AuditQueue,
    private readonly hashes: ImageHashPool,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Optional() @Inject(GALLERY_GRANTS) private readonly grants?: GalleryGrants,
  ) {}

  async create(sellerId: string, input: CreateLotDto) {
    const lot = await this.prisma.lot.create({
      data: {
        sellerId,
        title: input.title.trim(),
        description: input.description.trim(),
        artistName: input.artistName?.trim(),
        creationYear: input.creationYear,
        materials: input.materials.trim(),
        status: 'BORRADOR',
        visibility: 'PRIVATE',
      },
    });
    await this.grants?.grantOwnLot({ ownerId: sellerId, lotId: lot.id });
    return lot;
  }

  async listPublic() {
    return this.prisma.lot.findMany({
      where: { visibility: 'PUBLIC', status: { in: PUBLIC_STATUSES } },
      orderBy: { createdAt: 'desc' },
      include: {
        images: { orderBy: { position: 'asc' } },
        auction: { select: { id: true, status: true, currentPrice: true, endsAt: true } },
      },
    });
  }

  async getForViewer(lotId: string, viewerId: string | null) {
    const lot = await this.prisma.lot.findUnique({
      where: { id: lotId },
      include: {
        images: { orderBy: { position: 'asc' } },
        auditSummaries: { orderBy: { createdAt: 'desc' }, take: 1 },
        auction: { select: { id: true, status: true, currentPrice: true, endsAt: true } },
      },
    });
    if (!lot || !canViewLot(lot, viewerId)) {
      throw new NotFoundException('Obra no encontrada');
    }
    return lot;
  }

  signUpload(lotId: string, sellerId: string, contentType: string, position: number) {
    return this.ownedLot(lotId, sellerId).then(() => {
      const objectKey = `lots/${lotId}/${String(position)}`;
      return this.storage.signUpload(objectKey, contentType);
    });
  }

  async registerImage(lotId: string, sellerId: string, input: RegisterImageDto) {
    await this.ownedLot(lotId, sellerId);
    return this.prisma.lotImage.upsert({
      where: { lotId_position: { lotId, position: input.position } },
      update: { objectKey: input.objectKey, perceptualHash: input.perceptualHash },
      create: {
        lotId,
        objectKey: input.objectKey,
        position: input.position,
        perceptualHash: input.perceptualHash,
      },
    });
  }

  hashImage(bytes: Buffer): Promise<string> {
    return this.hashes.hash(bytes);
  }

  async submitForAudit(lotId: string, sellerId: string): Promise<void> {
    const lot = await this.ownedLot(lotId, sellerId);
    this.assertStatus(lot.status, 'PENDIENTE_AUDITORIA');
    await this.prisma.lot.update({ where: { id: lotId }, data: { status: 'PENDIENTE_AUDITORIA' } });
    await this.audits.enqueue(lotId);
  }

  async transition(lotId: string, to: string, patch: Prisma.LotUpdateInput = {}) {
    const lot = await this.prisma.lot.findUnique({ where: { id: lotId } });
    if (!lot) {
      throw new NotFoundException('Obra no encontrada');
    }
    this.assertStatus(lot.status, to);
    return this.prisma.lot.update({ where: { id: lotId }, data: { ...patch, status: to } });
  }

  private assertStatus(from: string, to: string): void {
    if (!canTransition(from, to)) {
      throw new BadRequestException(`Transición de lote ilegal: ${from} → ${to}`);
    }
  }

  private async ownedLot(lotId: string, sellerId: string) {
    const lot = await this.prisma.lot.findUnique({ where: { id: lotId } });
    if (!lot || lot.sellerId !== sellerId) {
      throw new NotFoundException('Obra no encontrada');
    }
    if (lot.status === 'CERRADO') {
      throw new BadRequestException('El lote está cerrado');
    }
    return lot;
  }
}
