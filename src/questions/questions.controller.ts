import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { QuestionsService } from './questions.service';
import { CreateQuestionDto } from './create-question.dto';
import { Question } from './question.entity';

@Controller('questions')
export class QuestionController {
  constructor(private readonly questionService: QuestionsService) {}

  // 📨 Guardar una nueva pregunta (desde el bot o un frontend)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() createDto: CreateQuestionDto): Promise<Question> {
    return this.questionService.saveWithoutResponse(createDto);
  }

  // 📋 Obtener todas las preguntas (opcional para admin)
  @Get()
  async findAll(): Promise<Question[]> {
    return this.questionService.findAll();
  }

  // 🔍 Buscar por texto exacto (útil para testing)
  @Get('search')
  async findByText(@Query('text') text: string): Promise<Question | null> {
    return this.questionService.findByText(text);
  }

  // 🔎 Ver una pregunta por ID
  @Get(':id')
  async findOne(@Param('id') id: number): Promise<Question | null> {
    return this.questionService.findOneById(id);
  }

  // 📊 Obtener estadísticas (opcional)
  @Get('stats')
  async obtenerEstadisticas() {
    return this.questionService.obtenerEstadisticas();
  }
}
