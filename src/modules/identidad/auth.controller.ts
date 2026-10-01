import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthService, type AuthUser } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { LoginDto, RefreshDto, RegisterDto } from './dto';

@ApiTags('identidad')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  register(@Body() body: RegisterDto): Promise<AuthUser> {
    return this.auth.register(body);
  }

  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  login(@Body() body: LoginDto) {
    return this.auth.login(body.email, body.password);
  }

  @HttpCode(200)
  @Post('refresh')
  refresh(@Body() body: RefreshDto) {
    return this.auth.refresh(body.refreshToken);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @Get('me')
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }
}
