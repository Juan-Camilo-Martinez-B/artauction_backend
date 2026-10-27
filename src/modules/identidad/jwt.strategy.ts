import { Inject, Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ENV, type Environment } from '../../common/config/environment';
import type { AuthUser } from './auth.service';

interface AccessPayload {
  sub: string;
  email: string;
  role: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(@Inject(ENV) env: Environment) {
    // Con la clave publica de identity-service solo se aceptan sus tokens RS256.
    const publicKey = env.identityPublicKey;
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: publicKey ?? env.JWT_ACCESS_SECRET,
      algorithms: publicKey ? ['RS256'] : ['HS256'],
    });
  }

  validate(payload: AccessPayload): AuthUser {
    return { userId: payload.sub, email: payload.email, role: payload.role };
  }
}
