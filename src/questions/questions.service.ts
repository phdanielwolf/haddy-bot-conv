import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Question } from './question.entity';
import { CreateQuestionDto } from './create-question.dto';

@Injectable()
export class QuestionsService {
  constructor(
    @InjectRepository(Question)
    private readonly questionRepository: Repository<Question>,
  ) {}

  // Guarda solo la pregunta sin respuesta
  async saveWithoutResponse(dto: CreateQuestionDto): Promise<Question> {
    const partial = this.questionRepository.create(dto);
    return this.questionRepository.save(partial);
  }

  // Actualiza la respuesta de un mensaje ya guardado
  async updateResponse(id: number, response: string): Promise<Question> {
    const question = await this.questionRepository.findOne({ where: { id } });
    if (!question) throw new Error('Pregunta no encontrada');
    question.response = response;
    return this.questionRepository.save(question);
  }

  // Buscar una pregunta por su texto (opcional)
  async findByText(text: string): Promise<Question | null> {
    return this.questionRepository.findOne({
      where: { questionText: text },
    });
  }

  async findOneById(id: number): Promise<Question | null> {
    return this.questionRepository.findOne({ where: { id } });
  }

  async obtenerEstadisticas() {
    // Ejemplo: total de preguntas, 10 preguntas ultimas
    const total = await this.questionRepository.count();
    const topPreguntas = await this.questionRepository.find({
      order: { id: 'DESC' },
      take: 10,
    });
    return { total, topPreguntas };
  }

  // Obtener historial
  async findAll(): Promise<Question[]> {
    return this.questionRepository.find({ order: { createdAt: 'DESC' } });
  }
}
