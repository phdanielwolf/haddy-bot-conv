import { Module } from '@nestjs/common';
import { WwebjsService } from './wwebjs.service';
import { WhatsappQrController, WwebjsController } from './wwebjs.controller';
import { BotSynergysService } from 'src/botsynergys/botsynergys.service';
import { SheetsService } from 'src/sheets/sheets.service';
import { LocalAIService } from 'src/localai/localai.service';
import { OllamaService } from 'src/ia/ollama.service';
import { OpenAiService } from 'src/ia/openai.service';
import { QuestionsModule } from '../questions/questions.module';
import { ImageAnalysisModule } from 'src/image-analysis/image-analysis.module';
import { GptVisionModule } from 'src/gpt-vision/gpt-vision.module';
import { ChatGptTextModule } from 'src/chatgpt-text/chatgpt-text.module';
import { GoogleDriveModule } from 'src/google-drive/google-drive.module';
import { DropboxModule } from 'src/dropbox/dropbox.module';

@Module({
  imports: [
    QuestionsModule,
    ImageAnalysisModule,
    GptVisionModule,
    ChatGptTextModule,
    GoogleDriveModule,
    DropboxModule,
  ],
  controllers: [WwebjsController, WhatsappQrController],
  providers: [
    WwebjsService,
    BotSynergysService,
    SheetsService,
    LocalAIService,
    OllamaService,
    OpenAiService,
  ],
  exports: [WwebjsService],
})
export class WwebjsModule {}
