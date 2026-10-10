import { Module } from '@nestjs/common';
import { ENV, type Environment } from '../../common/config/environment';
import { IdentidadModule } from '../identidad/identidad.module';
import { GaleriaPersonalController } from './galeria-personal.controller';
import { GaleriaPersonalService } from './galeria-personal.service';
import { GALLERY_DESIGN, GeminiGalleryDesignAdapter, LocalGalleryDesignAdapter, type GalleryDesignPort } from './gallery-design.port';

@Module({
  imports: [IdentidadModule],
  controllers: [GaleriaPersonalController],
  providers: [
    GaleriaPersonalService,
    LocalGalleryDesignAdapter,
    GeminiGalleryDesignAdapter,
    {
      provide: GALLERY_DESIGN,
      inject: [ENV, LocalGalleryDesignAdapter, GeminiGalleryDesignAdapter],
      useFactory: (env: Environment, local: LocalGalleryDesignAdapter, gemini: GeminiGalleryDesignAdapter): GalleryDesignPort =>
        env.geminiConfigured ? gemini : local,
    },
  ],
})
export class GaleriaPersonalModule {}
