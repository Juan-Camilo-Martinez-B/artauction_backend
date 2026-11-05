import type { Account, Locale, ProfileVisibility, Role } from '../domain/account';

export interface AccountView {
  userId: string;
  email: string;
  role: Role;
  displayName: string;
  avatarUrl: string | null;
  locale: Locale;
}

export interface PublicProfileView {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  visibility: ProfileVisibility;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

export function toAccountView(account: Account): AccountView {
  return {
    userId: account.id,
    email: account.email,
    role: account.role,
    displayName: account.displayName,
    avatarUrl: account.avatarUrl,
    locale: account.locale,
  };
}
