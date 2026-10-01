import { Global, Module } from '@nestjs/common';
import { ENV, loadEnvironment } from './environment';

@Global()
@Module({
  providers: [{ provide: ENV, useFactory: () => loadEnvironment() }],
  exports: [ENV],
})
export class EnvModule {}
