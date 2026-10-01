import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../identidad/auth.service';
import { CurrentUser } from '../identidad/current-user.decorator';
import { Roles, RolesGuard } from '../identidad/roles.guard';
import { AuctionsService } from './auctions.service';
import { BidsService } from './bids.service';
import { OpenAuctionDto, PlaceBidDto } from './dto';

@ApiTags('subastas')
@Controller('auctions')
export class AuctionsController {
  constructor(
    private readonly auctions: AuctionsService,
    private readonly bids: BidsService,
  ) {}

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.auctions.getOne(id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('SELLER', 'ADMIN')
  @Post()
  open(@CurrentUser() user: AuthUser, @Body() body: OpenAuctionDto) {
    return this.auctions.open(user.userId, body);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @Post(':id/bids')
  place(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: PlaceBidDto) {
    return this.bids.placeBid({
      auctionId: id,
      bidderId: user.userId,
      amount: body.amount,
      idempotencyKey: body.idempotencyKey,
    });
  }
}
