import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VenomService } from './venom.service';
import { VenomController } from './venom.controller';
import { BotSynergysService } from 'src/botsynergys/botsynergys.service';
import { BotService } from 'src/bot/bot.service';
import { QuestionsService } from 'src/questions/questions.service';

@Module({
  imports: [BotSynergysService, BotService, QuestionsService],
  providers: [VenomService],
  controllers: [VenomController],
  exports: [VenomService],
})
export class VenomModule {}
