import { Body, Controller, Get, Headers, HttpCode, Inject, Patch, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { identityV1 } from '@artauction/contracts';
import { invoke } from '@artauction/service-kit';
import { IDENTITY_CLIENT } from '../../../clients/grpc-clients';
import { GATEWAY_CONFIG } from '../tokens';
import type { GatewayConfig } from '../../../config';
import { LoginDto, RefreshDto, RegisterDto, UpdateProfileDto } from './auth.dto';

export interface AccountJson {
  userId: string;
  email: string;
  role: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface TokenPairJson {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

const ROLE_NAMES: ReadonlyMap<identityV1.Role, string> = new Map([
  [identityV1.Role.ROLE_USER, 'USER'],
  [identityV1.Role.ROLE_SELLER, 'SELLER'],
  [identityV1.Role.ROLE_ADMIN, 'ADMIN'],
]);

const ROLE_VALUES: Readonly<Record<'USER' | 'SELLER', identityV1.Role>> = {
  USER: identityV1.Role.ROLE_USER,
  SELLER: identityV1.Role.ROLE_SELLER,
};

/** Rutas /auth del contrato REST, servidas por identity-service. */
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(IDENTITY_CLIENT) private readonly identity: identityV1.IdentityServiceClient,
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
  ) {}

  @Post('register')
  async register(@Body() body: RegisterDto): Promise<AccountJson> {
    const response = await invoke(
      this.identity.register.bind(this.identity),
      identityV1.RegisterRequest.fromPartial({
        email: body.email,
        password: body.password,
        displayName: body.displayName,
        role: body.role ? ROLE_VALUES[body.role] : identityV1.Role.ROLE_UNSPECIFIED,
      }),
      this.options(),
    );
    return toAccountJson(response.account);
  }

  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  async login(@Body() body: LoginDto): Promise<TokenPairJson> {
    const response = await invoke(
      this.identity.login.bind(this.identity),
      identityV1.LoginRequest.fromPartial({ email: body.email, password: body.password }),
      this.options(),
    );
    return toTokensJson(response.tokens);
  }

  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  async refresh(@Body() body: RefreshDto): Promise<TokenPairJson> {
    const response = await invoke(
      this.identity.refreshSession.bind(this.identity),
      identityV1.RefreshSessionRequest.fromPartial({ refreshToken: body.refreshToken }),
      this.options(),
    );
    return toTokensJson(response.tokens);
  }

  @Get('me')
  async me(@Headers('authorization') authorization: string | undefined): Promise<AccountJson> {
    const response = await invoke(
      this.identity.getAccount.bind(this.identity),
      identityV1.GetAccountRequest.fromPartial({}),
      this.options(authorization),
    );
    return toAccountJson(response.account);
  }

  @Patch('me')
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: UpdateProfileDto,
  ): Promise<AccountJson> {
    const response = await invoke(
      this.identity.updateProfile.bind(this.identity),
      identityV1.UpdateProfileRequest.fromPartial({ displayName: body.displayName, avatarUrl: body.avatarUrl }),
      this.options(authorization),
    );
    return toAccountJson(response.account);
  }

  private options(authorization?: string) {
    return { deadlineMs: this.config.GRPC_DEADLINE_MS, authorization };
  }
}

function toAccountJson(account: identityV1.Account | undefined): AccountJson {
  if (!account) {
    throw new Error('identity-service respondio sin cuenta');
  }
  return {
    userId: account.userId,
    email: account.email,
    role: ROLE_NAMES.get(account.role) ?? 'USER',
    displayName: account.displayName,
    avatarUrl: account.avatarUrl ?? null,
  };
}

function toTokensJson(tokens: identityV1.TokenPair | undefined): TokenPairJson {
  if (!tokens) {
    throw new Error('identity-service respondio sin tokens');
  }
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresIn: tokens.expiresIn };
}
