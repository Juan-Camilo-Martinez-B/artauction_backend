import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../identidad/auth.service';
import { CurrentUser } from '../identidad/current-user.decorator';
import { TopUpDto } from './dto';
import { WalletService } from './wallet.service';

@ApiTags('bolsillo')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get()
  snapshot(@CurrentUser() user: AuthUser) {
    return this.wallet.snapshot(user.userId);
  }

  @Post('top-ups')
  topUp(@CurrentUser() user: AuthUser, @Body() body: TopUpDto) {
    return this.wallet.topUp(user.userId, body);
  }
}
