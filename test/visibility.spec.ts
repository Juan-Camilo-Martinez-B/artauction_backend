import { canViewGalleryItem, canViewLot } from '../src/common/domain/visibility';

describe('visibilidad', () => {
  const lot = { visibility: 'PRIVATE', sellerId: 'seller' };

  it('oculta una obra privada a terceros', () => {
    expect(canViewLot(lot, null)).toBe(false);
    expect(canViewLot(lot, 'otro')).toBe(false);
    expect(canViewLot(lot, 'seller')).toBe(true);
  });

  it('muestra el catálogo público', () => {
    expect(canViewLot({ visibility: 'PUBLIC', sellerId: 'seller' }, null)).toBe(true);
    expect(canViewGalleryItem({ visibility: 'PUBLIC', ownerId: 'owner' }, null)).toBe(true);
    expect(canViewGalleryItem({ visibility: 'PRIVATE', ownerId: 'owner' }, 'otro')).toBe(false);
  });
});
