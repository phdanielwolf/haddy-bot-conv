import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Question } from './question.entity';
import { QuestionsService } from './questions.service';
import { QuestionController } from './questions.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Question])],
  providers: [QuestionsService],
  controllers: [QuestionController],
  exports: [QuestionsService],
})
export class QuestionsModule {}
