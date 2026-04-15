import { Injectable } from '@nestjs/common';
import { OpenAI } from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

@Injectable()
export class OpenAiService {
  async consultar(
    mensajes: ChatMessage[] | string,
    model: 'gpt-4' | 'gpt-3.5-turbo' = 'gpt-3.5-turbo',
  ): Promise<string> {
    try {
      const response = await openai.chat.completions.create({
        model,
        messages: Array.isArray(mensajes)
          ? mensajes
          : [{ role: 'user', content: mensajes }],
        max_tokens: 1024,
      });

      return response.choices?.[0]?.message?.content || 'Sin respuesta.';
    } catch (error) {
      console.error('Error en OpenAI:', error);
      return 'Error al consultar IA.';
    }
  }

  async transcribeAudio(audioBuffer: Buffer): Promise<string> {
    const tempFilePath = path.join(os.tmpdir(), `audio-${Date.now()}.mp3`);
    try {
      fs.writeFileSync(tempFilePath, audioBuffer);
      const response = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tempFilePath),
        model: 'whisper-1',
      });
      return response.text;
    } catch (error) {
      console.error('Error transcribing audio:', error);
      return 'Error al transcribir el audio.';
    } finally {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    }
  }
}
