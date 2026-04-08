import { Module } from '@nestjs/common';
import { ChatGptTextService } from './chatgpt-text.service';

@Module({
  providers: [ChatGptTextService],
  exports: [ChatGptTextService],
})
export class ChatGptTextModule {}
