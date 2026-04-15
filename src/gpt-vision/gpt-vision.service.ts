import { Injectable, Logger } from '@nestjs/common';
import { OpenAI } from 'openai';
import * as fs from 'fs/promises';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class GptVisionService {
  private openai: OpenAI;
  private readonly logger = new Logger(GptVisionService.name);

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get('OPENAI_API_KEY_VISION');
    this.openai = new OpenAI({ apiKey });
  }

  async revisarImagen(imagePath: string, from: string) {
    try {
      const imageBuffer = await fs.readFile(imagePath);
      const base64Image = imageBuffer.toString('base64');

      const prompt = `Extraé de esta imagen los siguientes datos si están visibles:
- Fecha (en formato dd/mm/yyyy)
- Hora (hh:mm:ss, si es posible)
- Latitud (decimal)
- Longitud (decimal)
- Rostro detectado (true o false)

Devuelve solo un JSON con este formato:
{
  "date": "dd/mm/yyyy hh:mm:ss",
  "lat": -27.12345,
  "lng": -66.98765,
  "faceDetected": true
}`;

      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content:
              'Sos un asistente experto en extraer información de imágenes con coordenadas y fecha/hora.',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`,
                },
              },
            ],
          },
        ],
        temperature: 0.3,
        max_tokens: 1000,
      });

      const reply =
        response.choices[0]?.message?.content ||
        'No se encontró información relevante.';
      this.logger.debug(`Respuesta de GPT-4 Vision para ${from}: ${reply}`);

      const cleanJson = reply
        .replace(/^```json\n?/, '')
        .replace(/^```/, '')
        .replace(/```$/, '')
        .trim();

      let result: any;
      try {
        result = JSON.parse(cleanJson);
      } catch (parseError) {
        this.logger.error(`❌ Error al parsear JSON para ${from}:`, parseError);
        return {
          date: null,
          lat: null,
          lng: null,
          faceDetected: null,
          source: 'error',
        };
      }

      return {
        ...result,
        source: 'gpt-4-vision',
      };
    } catch (error) {
      this.logger.error(
        `❌ Error al procesar imagen con GPT para ${from}:`,
        error,
      );
      return {
        date: null,
        lat: null,
        lng: null,
        faceDetected: null,
        source: 'error',
      };
    }
  }
}
