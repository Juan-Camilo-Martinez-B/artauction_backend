import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { type TestingModule, Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import { EnvModule } from '../src/common/config/env.module';
import { MongoModule } from '../src/infra/mongo/mongo.module';
import { PrismaService } from '../src/infra/postgres/prisma.service';
import { PostgresModule } from '../src/infra/postgres/postgres.module';
import { CatalogoService } from '../src/modules/catalogo/catalogo.service';
import { CatalogoModule } from '../src/modules/catalogo/catalogo.module';
import { GaleriaPersonalService } from '../src/modules/galeria-personal/galeria-personal.service';
import { GaleriaPersonalModule } from '../src/modules/galeria-personal/galeria-personal.module';

process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] ??=
  'postgresql://artauction:artauction@127.0.0.1:54329/artauction?schema=public';
process.env['MONGODB_URI'] ??= 'mongodb://127.0.0.1:27018/artauction';
process.env['JWT_ACCESS_SECRET'] ??= 'ci-access-secret-value';
process.env['JWT_REFRESH_SECRET'] ??= 'ci-refresh-secret-value';
process.env['CORS_ORIGINS'] ??= 'http://localhost:3000';

const ivory = {
  artStyles: ['impresionismo'],
  favoriteStyle: 'impresionismo',
  atmosphere: 'sereno',
  colorFamily: 'claros',
  paletteId: 'marfil',
  contrastWithArt: false,
  architecture: 'museo-clasico',
  layout: 'pocas',
  sculptureRole: 'complementarias',
  light: 'natural',
  lightMood: 'serenidad',
  intensity: 'media',
  materials: ['yeso'],
  sculptureDisplay: 'pedestales',
  tour: 'libre',
  approach: 'ficha',
  accessibility: 'ninguna',
};

const burgundy = {
  ...ivory,
  artStyles: ['barroco'],
  favoriteStyle: 'barroco',
  paletteId: 'borgona',
  architecture: 'loft',
  light: 'dramatica',
  intensity: 'baja',
  materials: ['metal'],
};

function wall(config: unknown): string {
  if (typeof config !== 'object' || config === null || !('palette' in config)) {
    return '';
  }
  const palette = config.palette;
  if (typeof palette !== 'object' || palette === null || !('wall' in palette)) {
    return '';
  }
  return typeof palette.wall === 'string' ? palette.wall : '';
}

describe('galería personal y catálogo', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaClient;
  let galleries: GaleriaPersonalService;
  let catalogo: CatalogoService;
  const userIds: string[] = [];
  const lotIds: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [EnvModule, PostgresModule, MongoModule.forRoot(), CatalogoModule, GaleriaPersonalModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    galleries = moduleRef.get(GaleriaPersonalService);
    catalogo = moduleRef.get(CatalogoService);
  });

  afterAll(async () => {
    if (userIds.length > 0) {
      await prisma.personalGallery.deleteMany({ where: { ownerId: { in: userIds } } });
    }
    if (lotIds.length > 0) {
      await prisma.lot.deleteMany({ where: { id: { in: lotIds } } });
    }
    if (userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await moduleRef.close();
  });

  async function user(role: 'USER' | 'SELLER') {
    const created = await prisma.user.create({
      data: {
        email: `${randomUUID()}@galeria.test`,
        passwordHash: 'hash',
        displayName: 'Tester',
        role,
      },
    });
    userIds.push(created.id);
    return created;
  }

  it('aísla la sala de cada persona y no guarda una configuración inválida', async () => {
    const ada = await user('USER');
    const nora = await user('USER');
    const adaRoom = await galleries.generate(ada.id, ivory, false, false);
    const noraRoom = await galleries.generate(nora.id, burgundy, false, false);

    expect(adaRoom.ownerId).toBe(ada.id);
    expect(noraRoom.ownerId).toBe(nora.id);
    expect(adaRoom.id).not.toBe(noraRoom.id);
    expect(wall(adaRoom.appliedConfig)).toBe('#f4efe4');
    expect(wall(noraRoom.appliedConfig)).not.toBe(wall(adaRoom.appliedConfig));

    const revisited = await galleries.mine(ada.id);
    expect(revisited.id).toBe(adaRoom.id);
    expect(wall(revisited.appliedConfig)).toBe('#f4efe4');

    await expect(galleries.applyManual(ada.id, { schemaVersion: 1, palette: { wall: 'rojo' } })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(wall((await galleries.mine(ada.id)).appliedConfig)).toBe('#f4efe4');

    const edited = await galleries.applyManual(ada.id, {
      ...(adaRoom.appliedConfig as object),
      lighting: { ambientIntensity: 0.2, colorTemperature: 3200, spotIntensity: 0.4, mood: 'misterio' },
    });
    expect(edited.customizationStatus).toBe('EDITADA');
    await expect(galleries.generate(ada.id, burgundy, false, false)).rejects.toBeInstanceOf(ConflictException);
    expect(wall((await galleries.mine(ada.id)).appliedConfig)).toBe('#f4efe4');
  });

  it('solo coloca obras públicas en la galería de quien las añade', async () => {
    const owner = await user('USER');
    const other = await user('USER');
    const seller = await user('SELLER');
    const marker = `escultura-${randomUUID()}`;
    const hidden = await catalogo.create(seller.id, {
      title: `borrador-${marker}`,
      description: 'No debe entrar en ninguna sala.',
      materials: 'bronce',
    });
    lotIds.push(hidden.id);
    await expect(galleries.addArtwork(owner.id, hidden.id)).rejects.toBeInstanceOf(NotFoundException);

    const sculpture = await catalogo.create(seller.id, {
      title: marker,
      description: 'Volumen público para la sala personal.',
      materials: 'bronce',
      categorySlug: 'escultura',
      representationKind: 'THREE_D',
    });
    lotIds.push(sculpture.id);
    await prisma.lot.update({
      where: { id: sculpture.id },
      data: { status: 'APROBADO', visibility: 'PUBLIC' },
    });

    const placed = await galleries.addArtwork(owner.id, sculpture.id);
    expect(placed.artworks.map((item) => item.lotId)).toContain(sculpture.id);
    expect(placed.artworks.find((item) => item.lotId === sculpture.id)?.support).toBe('PEDESTAL');
    expect((await galleries.mine(other.id)).artworks).toHaveLength(0);

    await galleries.removeArtwork(other.id, sculpture.id);
    expect((await galleries.mine(owner.id)).artworks.map((item) => item.lotId)).toContain(sculpture.id);

    const matching = await catalogo.listPublic({ q: marker, category: 'escultura', representation: 'THREE_D' });
    expect(matching.items.map((item) => item.id)).toContain(sculpture.id);
    const otherCategory = await catalogo.listPublic({ q: marker, category: 'pinturas' });
    expect(otherCategory.total).toBe(0);
  });
});
