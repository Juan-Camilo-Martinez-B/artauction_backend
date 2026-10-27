import { Prisma, type PrismaClient, type User } from '../../generated/prisma';
import { isRole, type Account, type ProfileVisibility } from '../domain/account';
import type { AccountRepository } from '../application/ports';

const UNIQUE_VIOLATION = 'P2002';
const RECORD_NOT_FOUND = 'P2025';

export class PrismaAccountRepository implements AccountRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByEmail(email: string): Promise<Account | null> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    return user ? toAccount(user) : null;
  }

  async findById(id: string): Promise<Account | null> {
    if (!isUuid(id)) {
      return null;
    }
    const user = await this.prisma.user.findUnique({ where: { id } });
    return user ? toAccount(user) : null;
  }

  async create(input: { email: string; passwordHash: string; displayName: string; role: string }): Promise<Account | null> {
    try {
      return toAccount(await this.prisma.user.create({ data: input }));
    } catch (error) {
      if (isKnownError(error, UNIQUE_VIOLATION)) {
        return null;
      }
      throw error;
    }
  }

  async updateProfile(id: string, patch: { displayName: string; avatarUrl?: string | null }): Promise<Account | null> {
    if (!isUuid(id)) {
      return null;
    }
    try {
      return toAccount(await this.prisma.user.update({ where: { id }, data: patch }));
    } catch (error) {
      if (isKnownError(error, RECORD_NOT_FOUND)) {
        return null;
      }
      throw error;
    }
  }
}

function toAccount(user: User): Account {
  if (!isRole(user.role)) {
    throw new Error(`Rol desconocido en identity.users: ${user.role}`);
  }
  const visibility: ProfileVisibility = user.profileVisibility === 'PRIVATE' ? 'PRIVATE' : 'PUBLIC';
  return {
    id: user.id,
    email: user.email,
    passwordHash: user.passwordHash,
    displayName: user.displayName,
    role: user.role,
    profileVisibility: visibility,
    avatarUrl: user.avatarUrl,
  };
}

function isKnownError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
