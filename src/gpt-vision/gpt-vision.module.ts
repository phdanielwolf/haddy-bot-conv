import { Module } from '@nestjs/common';
import { GptVisionService } from './gpt-vision.service';

@Module({
  providers: [GptVisionService],
  exports: [GptVisionService],
})
export class GptVisionModule {}
