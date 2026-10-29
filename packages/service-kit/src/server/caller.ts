import { DomainError, type TokenVerifier, type UserRole } from '@artauction/platform';
import type { CallContext } from './unary';

export interface UserCaller {
  userId: string;
  role: UserRole;
}

/** Resuelve quien llama a partir del token de la metadata. */
export class CallerResolver {
  constructor(private readonly verifier: TokenVerifier) {}

  /** Exige un usuario autenticado. */
  user(context: CallContext): UserCaller {
    const principal = this.verifier.verifyBearer(context.authorization);
    if (principal.kind !== 'user') {
      throw DomainError.forbidden('Esta operacion requiere una cuenta de usuario');
    }
    return { userId: principal.userId, role: principal.role };
  }

  /** Usuario si trae un token valido; null si no trae ninguno o no es valido. */
  optionalUser(context: CallContext): UserCaller | null {
    if (context.authorization === undefined) {
      return null;
    }
    try {
      return this.user(context);
    } catch {
      return null;
    }
  }

  /** Exige un token de servicio; si se indican clientes, solo esos. */
  service(context: CallContext, allowed?: readonly string[]): string {
    const principal = this.verifier.verifyBearer(context.authorization);
    if (principal.kind !== 'service' || (allowed !== undefined && !allowed.includes(principal.clientId))) {
      throw DomainError.forbidden('Operacion reservada a servicios internos');
    }
    return principal.clientId;
  }
}
