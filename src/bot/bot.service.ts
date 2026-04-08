import { Injectable } from '@nestjs/common';
import { SheetsService } from '../sheets/sheets.service';
import { LocalAIService } from '../localai/localai.service';
import { OllamaService } from '../ia/ollama.service';
import { QuestionsService } from '../questions/questions.service';
import { OpenAiService } from '../ia/openai.service';

@Injectable()
export class BotService {
  constructor(
    private readonly sheetsService: SheetsService,
    private readonly localAIService: LocalAIService,
    private readonly ollamaService: OllamaService,
    private readonly questionsService: QuestionsService,
    private readonly openAiService: OpenAiService,
  ) {}

  async responder(
    mensajeUsuario: string,
    from: string,
    chatId: string,
  ): Promise<string> {
    console.log('[BotService] Mensaje recibido:', mensajeUsuario);

    // Leer datos de la hoja de cálculo
    const datos = await this.sheetsService.leerRango(
      process.env.SHEET_ID,
      'Alojamientos2!A1:E10',
    );

    // Construir el prompt
    const baseConocimiento = datos
      .map(([servicio, descripcion]) => `- ${servicio}: ${descripcion}`)
      .join('\n');

    const prompt = `
Sos un asistente inteligente que responde preguntas sobre servicios y alojamientos en la ciudad capital de Catamarca, Argentina.

Información:
${baseConocimiento}

El usuario pregunta: "${mensajeUsuario}"

Respondé de forma breve, clara, amigable y en español.
`.trim();

    /* return await this.localAIService.preguntar(prompt); */
    /* return await this.localAIService.preguntar(prompt); */
    /*     return await this.ollamaService.consultar(prompt);
     */
    return await this.openAiService.consultar([
      { role: 'system', content: prompt },
      { role: 'user', content: mensajeUsuario },
    ]);
  }
}
