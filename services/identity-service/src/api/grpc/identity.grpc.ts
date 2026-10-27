import { identityV1 } from '@artauction/contracts';
import { DomainError, type StructuredLogger, type TokenVerifier } from '@artauction/platform';
import { unary, type CallContext } from '@artauction/service-kit';
import type {
  GetAccount,
  GetPublicProfile,
  GetSigningKeys,
  IssueServiceToken,
  Login,
  RegisterAccount,
  RotateRefreshSession,
  UpdateProfile,
} from '../../internal/application/use-cases';
import { accountToProto, profileToProto, roleFromProto, tokensToProto } from './mappers';

export interface IdentityUseCases {
  register: RegisterAccount;
  login: Login;
  rotate: RotateRefreshSession;
  getAccount: GetAccount;
  updateProfile: UpdateProfile;
  getPublicProfile: GetPublicProfile;
  issueServiceToken: IssueServiceToken;
  getSigningKeys: GetSigningKeys;
}

/**
 * Frontera gRPC de identity-service. Solo traduce mensajes y resuelve quien
 * llama; las reglas viven en los casos de uso.
 */
export function identityGrpcService(
  useCases: IdentityUseCases,
  verifier: TokenVerifier,
  logger: StructuredLogger,
): identityV1.IdentityServiceServer {
  const currentUserId = (context: CallContext): string => {
    const principal = verifier.verifyBearer(context.authorization);
    if (principal.kind !== 'user') {
      throw DomainError.forbidden('Esta operacion requiere una cuenta de usuario');
    }
    return principal.userId;
  };

  return {
    register: unary(logger, 'Register', async (request) => {
      const account = await useCases.register.execute({
        email: request.email,
        password: request.password,
        displayName: request.displayName,
        role: roleFromProto(request.role),
      });
      return identityV1.RegisterResponse.fromPartial({ account: accountToProto(account) });
    }),

    login: unary(logger, 'Login', async (request) => {
      const tokens = await useCases.login.execute({ email: request.email, password: request.password });
      return identityV1.LoginResponse.fromPartial({ tokens: tokensToProto(tokens) });
    }),

    refreshSession: unary(logger, 'RefreshSession', async (request) => {
      if (request.refreshToken.length < 20) {
        throw DomainError.unauthenticated('Refresh token invalido');
      }
      const tokens = await useCases.rotate.execute(request.refreshToken);
      return identityV1.RefreshSessionResponse.fromPartial({ tokens: tokensToProto(tokens) });
    }),

    getAccount: unary(logger, 'GetAccount', async (_request, context) => {
      const account = await useCases.getAccount.execute(currentUserId(context));
      return identityV1.GetAccountResponse.fromPartial({ account: accountToProto(account) });
    }),

    updateProfile: unary(logger, 'UpdateProfile', async (request, context) => {
      const account = await useCases.updateProfile.execute({
        userId: currentUserId(context),
        displayName: request.displayName,
        avatarUrl: request.avatarUrl,
      });
      return identityV1.UpdateProfileResponse.fromPartial({ account: accountToProto(account) });
    }),

    getPublicProfile: unary(logger, 'GetPublicProfile', async (request) => {
      const profile = await useCases.getPublicProfile.execute(request.userId);
      return identityV1.GetPublicProfileResponse.fromPartial({ profile: profileToProto(profile) });
    }),

    getSigningKeys: unary(logger, 'GetSigningKeys', () =>
      Promise.resolve(identityV1.GetSigningKeysResponse.fromPartial({ keys: useCases.getSigningKeys.execute() })),
    ),

    issueServiceToken: unary(logger, 'IssueServiceToken', async (request) => {
      const issued = await useCases.issueServiceToken.execute({
        clientId: request.clientId,
        clientSecret: request.clientSecret,
      });
      return identityV1.IssueServiceTokenResponse.fromPartial({
        accessToken: issued.token,
        expiresInSeconds: issued.expiresInSeconds,
      });
    }),
  };
}
