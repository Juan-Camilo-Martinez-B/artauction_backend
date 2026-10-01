import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import * as argon2 from 'argon2';
import type { Model } from 'mongoose';
import { ENV, type Environment } from '../../common/config/environment';
import { durationToMs } from '../../common/time/duration';
import { RefreshSession } from '../../infra/mongo/refresh-session.schema';
import type { RegisterDto } from './dto';
import { UsersRepository } from './users.repository';

export interface AuthUser {
  userId: string;
  email: string;
  role: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersRepository,
    private readonly jwt: JwtService,
    @Inject(ENV) private readonly env: Environment,
    @InjectModel(RefreshSession.name) private readonly sessions: Model<RefreshSession>,
  ) {}

  async register(input: RegisterDto): Promise<AuthUser> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.users.findByEmail(email);
    if (existing) {
      throw new ConflictException('El correo ya está registrado');
    }
    const user = await this.users.create({
      email,
      passwordHash: await argon2.hash(input.password, { type: argon2.argon2id }),
      displayName: input.displayName.trim(),
      role: input.role ?? 'USER',
    });
    return { userId: user.id, email: user.email, role: user.role };
  }

  async login(email: string, password: string): Promise<TokenPair> {
    const user = await this.users.findByEmail(email.trim().toLowerCase());
    if (!user || !(await argon2.verify(user.passwordHash, password))) {
      throw new UnauthorizedException('Credenciales inválidas');
    }
    return this.issueTokens({ userId: user.id, email: user.email, role: user.role });
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const tokenHash = hashToken(refreshToken);
    const current = await this.sessions.findOne({ tokenHash }).exec();
    if (!current || current.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Refresh token inválido');
    }
    if (current.revokedAt) {
      await this.sessions.updateMany({ familyId: current.familyId }, { revokedAt: new Date() }).exec();
      throw new UnauthorizedException('Refresh token reutilizado');
    }
    const user = await this.users.findById(current.userId);
    if (!user) {
      throw new UnauthorizedException('Refresh token inválido');
    }
    const next = await this.issueTokens(
      { userId: user.id, email: user.email, role: user.role },
      current.familyId,
    );
    current.revokedAt = new Date();
    current.replacedByHash = hashToken(next.refreshToken);
    await current.save();
    return next;
  }

  private async issueTokens(user: AuthUser, familyId: string = randomUUID()): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync({
      sub: user.userId,
      email: user.email,
      role: user.role,
    });
    const refreshToken = randomBytes(32).toString('base64url');
    await this.sessions.create({
      userId: user.userId,
      tokenHash: hashToken(refreshToken),
      familyId,
      expiresAt: new Date(Date.now() + durationToMs(this.env.JWT_REFRESH_TTL)),
      revokedAt: null,
      replacedByHash: null,
    });
    return { accessToken, refreshToken, expiresIn: this.env.JWT_ACCESS_TTL };
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
