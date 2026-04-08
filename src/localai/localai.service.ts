import { Injectable } from '@nestjs/common';
import fetch from 'node-fetch';

@Injectable()
export class LocalAIService {
  async preguntar(mensaje: string): Promise<string> {
    const response = await fetch(process.env.LOCALAI_URL || '', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.LOCALAI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.LOCALAI_MODEL,
        messages: [{ role: 'user', content: mensaje }],
        temperature: 0.7,
      }),
    });

    const data = await response.json();
    return data?.choices?.[0]?.message?.content || 'Sin respuesta disponible';
  }
}
