import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { AuthUser } from './auth.service';

export const CurrentUser = createParamDecorator((_: unknown, context: ExecutionContext): AuthUser => {
  const request = context.switchToHttp().getRequest<{ user: AuthUser }>();
  return request.user;
});
