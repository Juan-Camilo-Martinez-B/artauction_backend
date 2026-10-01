import { Module } from '@nestjs/common';
import { IdentidadModule } from '../identidad/identidad.module';
import { AuctionBus } from './auction-bus';
import { AuctionsController } from './auctions.controller';
import { AuctionsService } from './auctions.service';
import { BidsService } from './bids.service';

@Module({
  imports: [IdentidadModule],
  controllers: [AuctionsController],
  providers: [AuctionBus, AuctionsService, BidsService],
  exports: [AuctionBus, BidsService],
})
export class SubastasModule {}
