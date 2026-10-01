import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OUTCOME_NOTIFIER } from '../../common/outcomes';
import { Notification, NotificationSchema } from './notification.schema';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: Notification.name, schema: NotificationSchema }])],
  controllers: [NotificationsController],
  providers: [NotificationsService, { provide: OUTCOME_NOTIFIER, useExisting: NotificationsService }],
  exports: [OUTCOME_NOTIFIER],
})
export class NotificacionesModule {}
