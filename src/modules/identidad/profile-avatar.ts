import { BadRequestException } from '@nestjs/common';

export class ProfileAvatar {
  static parse(value: string | null | undefined): string | null {
    if (value == null || value.trim() === '') {
      return null;
    }
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      throw new BadRequestException('La imagen de perfil tiene que ser una dirección https.');
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
      throw new BadRequestException('La imagen de perfil tiene que ser una dirección https.');
    }
    return url.toString();
  }
}
