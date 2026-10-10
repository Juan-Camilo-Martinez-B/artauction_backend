export class PublicObjectUrl {
  constructor(private readonly objectKey: string) {}

  href(): string | null {
    const key = this.objectKey.trim();
    if (!key.toLowerCase().startsWith('https://')) {
      return null;
    }
    try {
      const url = new URL(key);
      if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
        return null;
      }
      return url.toString();
    } catch {
      return null;
    }
  }
}

export class LotPresenter {
  static withPublicImages<T extends { images?: Array<{ objectKey: string }> | null }>(lot: T): T {
    if (!lot.images) {
      return lot;
    }
    return {
      ...lot,
      images: lot.images.map((image) => ({
        ...image,
        url: new PublicObjectUrl(image.objectKey).href(),
      })),
    };
  }

  static collection<T extends { images?: Array<{ objectKey: string }> | null }>(lots: T[]): T[] {
    return lots.map((lot) => this.withPublicImages(lot));
  }
}
