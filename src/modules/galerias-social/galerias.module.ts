import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { GALLERY_GRANTS } from '../../common/outcomes';
import { Activity, ActivitySchema } from './activity.schema';
import { GaleriasController } from './galerias.controller';
import { GaleriasService } from './galerias.service';
import { GalleryItem, GalleryItemSchema } from './gallery-item.schema';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: GalleryItem.name, schema: GalleryItemSchema },
      { name: Activity.name, schema: ActivitySchema },
    ]),
  ],
  controllers: [GaleriasController],
  providers: [GaleriasService, { provide: GALLERY_GRANTS, useExisting: GaleriasService }],
  exports: [GALLERY_GRANTS, GaleriasService],
})
export class GaleriasModule {}
