/**
 * Quien hace la peticion, tal como lo certifica un token firmado por
 * identity-service. Un usuario trae su rol de negocio; un servicio interno se
 * identifica con su client id y el rol SERVICE.
 */
export type UserRole = 'USER' | 'SELLER' | 'ADMIN';

export type Principal =
  | { kind: 'user'; userId: string; email: string; role: UserRole }
  | { kind: 'service'; clientId: string };

export const TOKEN_ISSUER = 'artauction-identity';
export const TOKEN_AUDIENCE = 'artauction';

export function isUserRole(value: unknown): value is UserRole {
  return value === 'USER' || value === 'SELLER' || value === 'ADMIN';
}
