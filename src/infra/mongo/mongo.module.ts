import { type DynamicModule, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EnvModule } from '../../common/config/env.module';
import { ENV, type Environment } from '../../common/config/environment';

@Module({})
export class MongoModule {
  static forRoot(): DynamicModule {
    return {
      module: MongoModule,
      imports: [
        MongooseModule.forRootAsync({
          imports: [EnvModule],
          inject: [ENV],
          useFactory: (env: Environment) => ({ uri: env.MONGODB_URI }),
        }),
      ],
    };
  }
}
