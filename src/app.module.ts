import { Module } from '@nestjs/common';
// import { VenomService } from './venom/venom.service';
import { BotService } from './bot/bot.service';
import { BotSynergysService } from './botsynergys/botsynergys.service';
import { SheetsService } from './sheets/sheets.service';
import { LocalAIService } from './localai/localai.service';
import { OllamaService } from './ia/ollama.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Question } from './questions/question.entity';
import { QuestionsService } from './questions/questions.service';
import { QuestionsModule } from './questions/questions.module';
import { OpenAiService } from './ia/openai.service';
// import { VenomModule } from './venom/venom.module';
// import { VenomController } from './venom/venom.controller';
import { BaileysModule } from './baileys/baileys.module';
import { BaileysController } from './baileys/baileys.controller';
import { WwebjsModule } from './wwebjs/wwebjs.module';
import {
  WhatsappQrController,
  WwebjsController,
} from './wwebjs/wwebjs.controller';
import { ImageAnalysisModule } from './image-analysis/image-analysis.module';
import { GptVisionModule } from './gpt-vision/gpt-vision.module';
import { ConfigModule } from '@nestjs/config';
import { ChatGptTextModule } from './chatgpt-text/chatgpt-text.module';
import { GoogleDriveModule } from './google-drive/google-drive.module';
import { DropboxModule } from './dropbox/dropbox.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      host: process.env.DATABASE_URL
        ? undefined
        : process.env.DB_HOST || 'localhost',
      port: process.env.DATABASE_URL
        ? undefined
        : parseInt(process.env.DB_PORT || '5432', 10),
      username: process.env.DATABASE_URL
        ? undefined
        : process.env.DB_USERNAME || 'admin',
      password: process.env.DATABASE_URL
        ? undefined
        : process.env.DB_PASSWORD || 'admin123',
      database: process.env.DATABASE_URL
        ? undefined
        : process.env.DB_NAME || 'bot_turismo',
      ssl:
        process.env.DB_SSL === 'true' || !!process.env.DATABASE_URL
          ? { rejectUnauthorized: false }
          : false,
      entities: [__dirname + '/**/*.entity{.ts,.js}'],
      synchronize: process.env.NODE_ENV !== 'production',
    }),
    TypeOrmModule.forFeature([Question]),
    QuestionsModule,
    ImageAnalysisModule,
    GptVisionModule,
    ChatGptTextModule,
    GoogleDriveModule,
    DropboxModule,
    //BaileysModule,
    WwebjsModule,
  ],
  providers: [
    BotSynergysService,
    BotService,
    SheetsService,
    LocalAIService,
    OllamaService,
    OpenAiService,
  ],
  controllers: [
    //BaileysController,
    WwebjsController,
    WhatsappQrController,
  ],
})
export class AppModule {}
