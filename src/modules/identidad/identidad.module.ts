import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { EnvModule } from '../../common/config/env.module';
import { ENV, type Environment } from '../../common/config/environment';
import { durationToSeconds } from '../../common/time/duration';
import { RefreshSession, RefreshSessionSchema } from '../../infra/mongo/refresh-session.schema';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { OptionalJwtAuthGuard } from './optional-jwt.guard';
import { RolesGuard } from './roles.guard';
import { UsersRepository } from './users.repository';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [EnvModule],
      inject: [ENV],
      useFactory: (env: Environment) => ({
        secret: env.JWT_ACCESS_SECRET,
        signOptions: { expiresIn: durationToSeconds(env.JWT_ACCESS_TTL) },
      }),
    }),
    MongooseModule.forFeature([{ name: RefreshSession.name, schema: RefreshSessionSchema }]),
  ],
  controllers: [AuthController],
  providers: [AuthService, UsersRepository, JwtStrategy, RolesGuard, OptionalJwtAuthGuard],
  exports: [AuthService, RolesGuard, OptionalJwtAuthGuard, JwtModule],
})
export class IdentidadModule {}
