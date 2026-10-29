import { DomainError } from '@artauction/platform';

export const ROLES = ['USER', 'SELLER', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

/** Roles que una persona puede elegir al registrarse. ADMIN solo se asigna fuera de la API. */
export const SELF_ASSIGNABLE_ROLES: readonly Role[] = ['USER', 'SELLER'];

export type ProfileVisibility = 'PUBLIC' | 'PRIVATE';

export interface Account {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  role: Role;
  profileVisibility: ProfileVisibility;
  avatarUrl: string | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 10;
const MAX_PASSWORD = 256;

export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) {
    throw DomainError.invalid('El correo no es valido.');
  }
  return email;
}

export function assertPasswordPolicy(password: string): void {
  if (password.length < MIN_PASSWORD) {
    throw DomainError.invalid(`La contrasena debe tener al menos ${String(MIN_PASSWORD)} caracteres.`);
  }
  if (password.length > MAX_PASSWORD) {
    throw DomainError.invalid('La contrasena es demasiado larga.');
  }
}

export function normalizeDisplayName(raw: string): string {
  const name = raw.trim();
  if (name.length < 2 || name.length > 80) {
    throw DomainError.invalid('El nombre debe tener entre 2 y 80 caracteres.');
  }
  return name;
}

export function registrationRole(requested: Role | undefined): Role {
  const role = requested ?? 'USER';
  if (!SELF_ASSIGNABLE_ROLES.includes(role)) {
    throw DomainError.forbidden('Ese rol no se puede elegir al registrarse.');
  }
  return role;
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/**
 * Imagen de perfil: vacio vuelve a las iniciales; si hay valor, tiene que ser
 * una URL https sin credenciales embebidas.
 */
export function parseAvatarUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw DomainError.invalid('La imagen de perfil tiene que ser una direccion https.');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || trimmed.length > 500) {
    throw DomainError.invalid('La imagen de perfil tiene que ser una direccion https.');
  }
  return url.toString();
}
