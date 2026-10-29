import { Logger, Module } from '@nestjs/common';
import { aiV1, identityV1 } from '@artauction/contracts';
import { channelCredentials } from '@artauction/platform';
import { ServiceTokenProvider } from '@artauction/service-kit';
import { ENV, type Environment } from '../../common/config/environment';
import { IdentidadModule } from '../identidad/identidad.module';
import { GaleriaPersonalController } from './galeria-personal.controller';
import { GaleriaPersonalService } from './galeria-personal.service';
import { AiServiceGalleryDesignAdapter, GALLERY_DESIGN, LocalGalleryDesignAdapter, type GalleryDesignPort } from './gallery-design.port';

@Module({
  imports: [IdentidadModule],
  controllers: [GaleriaPersonalController],
  providers: [
    GaleriaPersonalService,
    LocalGalleryDesignAdapter,
    {
      provide: GALLERY_DESIGN,
      inject: [ENV, LocalGalleryDesignAdapter],
      useFactory: (env: Environment, local: LocalGalleryDesignAdapter): GalleryDesignPort => {
        if (!env.aiServiceConfigured) {
          return local;
        }
        const channel = channelCredentials({ enabled: false });
        const identity = new identityV1.IdentityServiceClient(env.IDENTITY_GRPC_URL, channel);
        return new AiServiceGalleryDesignAdapter(
          new aiV1.AiServiceClient(env.AI_GRPC_URL, channel),
          new ServiceTokenProvider(identity, 'gallery-service', env.GALLERY_SERVICE_CLIENT_SECRET),
          local,
          new Logger('GalleryDesign'),
        );
      },
    },
  ],
})
export class GaleriaPersonalModule {}
