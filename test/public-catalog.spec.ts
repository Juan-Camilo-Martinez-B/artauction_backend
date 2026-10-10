import { BadRequestException } from '@nestjs/common';
import { LotPresenter, PublicObjectUrl } from '../src/modules/catalogo/public-object-url';
import { ProfileAvatar } from '../src/modules/identidad/profile-avatar';

describe('dirección pública de una obra', () => {
  it('publica una imagen https y rechaza una clave local o insegura', () => {
    expect(new PublicObjectUrl('https://images.metmuseum.org/obra.jpg').href()).toBe(
      'https://images.metmuseum.org/obra.jpg',
    );
    expect(new PublicObjectUrl('lots/obra/0.jpg').href()).toBeNull();
    expect(new PublicObjectUrl('http://images.metmuseum.org/obra.jpg').href()).toBeNull();
    expect(new PublicObjectUrl('https://user:secret@images.metmuseum.org/obra.jpg').href()).toBeNull();
  });

  it('adjunta la dirección a cada imagen del lote', () => {
    const presented = LotPresenter.withPublicImages({
      id: 'lot',
      images: [{ objectKey: 'https://images.metmuseum.org/obra.jpg' }],
    });
    expect(presented.images?.[0]).toMatchObject({ url: 'https://images.metmuseum.org/obra.jpg' });
  });
});

describe('imagen de perfil', () => {
  it('acepta https y vacía el campo cuando no hay dirección', () => {
    expect(ProfileAvatar.parse('https://images.metmuseum.org/retrato.jpg')).toBe(
      'https://images.metmuseum.org/retrato.jpg',
    );
    expect(ProfileAvatar.parse('  ')).toBeNull();
  });

  it('rechaza una dirección que no es https', () => {
    expect(() => ProfileAvatar.parse('javascript:alert(1)')).toThrow(BadRequestException);
  });
});
