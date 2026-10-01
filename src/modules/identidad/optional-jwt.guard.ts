import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  override handleRequest<TUser>(err: unknown, user: TUser | false | null | undefined): TUser | null {
    if (err || user === false || user === null || user === undefined) {
      return null;
    }
    return user;
  }
}
