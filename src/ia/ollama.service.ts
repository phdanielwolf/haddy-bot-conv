import { Injectable } from '@nestjs/common';
import fetch from 'node-fetch';

@Injectable()
export class OllamaService {
  async consultar(prompt: string): Promise<string> {
    try {
      const res = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        body: JSON.stringify({ model: 'mistral', prompt, stream: false }),
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await res.json();
      return (data as { response?: string }).response || 'Sin respuesta.';
    } catch (error) {
      console.error('Error en Ollama:', error.message);
      return 'Error al consultar IA local.';
    }
  }
}
