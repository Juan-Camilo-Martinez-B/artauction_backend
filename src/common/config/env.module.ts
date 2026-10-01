import { Module } from '@nestjs/common';
import { ENV, loadEnvironment } from './environment';

@Module({
  providers: [{ provide: ENV, useFactory: () => loadEnvironment() }],
  exports: [ENV],
})
export class EnvModule {}
