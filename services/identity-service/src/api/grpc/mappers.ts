import { commonV1, identityV1 } from '@artauction/contracts';
import { DomainError } from '@artauction/platform';
import type { Role } from '../../internal/domain/account';
import type { AccountView, PublicProfileView, TokenPair } from '../../internal/application/views';

const ROLE_TO_PROTO: Readonly<Record<Role, identityV1.Role>> = {
  USER: identityV1.Role.ROLE_USER,
  SELLER: identityV1.Role.ROLE_SELLER,
  ADMIN: identityV1.Role.ROLE_ADMIN,
};

export function roleFromProto(role: identityV1.Role): Role | undefined {
  switch (role) {
    case identityV1.Role.ROLE_UNSPECIFIED:
      return undefined;
    case identityV1.Role.ROLE_USER:
      return 'USER';
    case identityV1.Role.ROLE_SELLER:
      return 'SELLER';
    case identityV1.Role.ROLE_ADMIN:
      return 'ADMIN';
    default:
      throw DomainError.invalid('Rol desconocido.');
  }
}

export function accountToProto(view: AccountView): identityV1.Account {
  return identityV1.Account.fromPartial({
    userId: view.userId,
    email: view.email,
    role: ROLE_TO_PROTO[view.role],
    displayName: view.displayName,
    avatarUrl: view.avatarUrl ?? undefined,
  });
}

export function tokensToProto(pair: TokenPair): identityV1.TokenPair {
  return identityV1.TokenPair.fromPartial(pair);
}

export function profileToProto(view: PublicProfileView): identityV1.PublicProfile {
  return identityV1.PublicProfile.fromPartial({
    userId: view.userId,
    displayName: view.displayName,
    avatarUrl: view.avatarUrl ?? undefined,
    visibility:
      view.visibility === 'PUBLIC'
        ? commonV1.Visibility.VISIBILITY_PUBLIC
        : commonV1.Visibility.VISIBILITY_PRIVATE,
  });
}
