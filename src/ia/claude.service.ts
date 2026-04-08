import { Injectable } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class ClaudeService {
  async consultar(prompt: string): Promise<string> {
    try {
      const res = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-3-sonnet-20240229',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1024,
        },
        {
          headers: {
            'x-api-key': process.env.CLAUDE_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
        },
      );

      return res.data?.content?.[0]?.text || 'Sin respuesta.';
    } catch (error) {
      console.error('Error en Claude:', error.message);
      return 'Error al consultar IA.';
    }
  }
}
