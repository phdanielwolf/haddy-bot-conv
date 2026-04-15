// src/services/chatgpt-text.service.ts
import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';

@Injectable()
export class ChatGptTextService {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  async extraerNombreVehiculo(texto: string): Promise<{
    nombre?: string;
    lugarTrabajo?: string;
    esEntradaSalida?: string;
  }> {
    const prompt = `
Analizá el siguiente mensaje y extraé SOLO los siguientes campos:
- "nombre": el nombre de la persona mencionada (si no hay, usar "").
- "lugarTrabajo": el lugar donde presta servicio (puede ser un vehículo, abreviatura o un lugar físico). 
   Si aparece una abreviatura al inicio como "AP", "ALFA", "LT2D", etc., también debe considerarse lugar de trabajo.
   Si no se menciona, usar "".
- "esEntradaSalida": puede ser "entrada", "salida" o "vacio".

Reglas:
1. Respondé **únicamente** en formato JSON válido.
2. El orden de los datos en el mensaje puede variar: nombre, lugar de trabajo y entrada/salida pueden estar al principio, en el medio o al final. 
   Siempre identificá los 3 campos aunque estén desordenados.
3. Los mensajes pueden estar escritos con guiones, comas, mayúsculas, abreviaturas o espacios entre los datos.
   Ejemplos: 
   - "AP, CARDENAS ANGEL , FINALIZA JORNADA"
   - "Alfa 1- pinto Matías - salida"
   - "Juan Pérez, entrada, Alfa 1"
   - "Salida - Alfa 2 - Angel Moyano"
4. No inventes datos: si no se menciona algo, devolvé "" para nombre y lugarTrabajo, y "vacio" para esEntradaSalida.
5. Si el mensaje menciona "entrada", "inicia jornada", "comienzo" o similar → esEntradaSalida = "entrada".
6. Si el mensaje menciona "salida", "finaliza jornada", "termina jornada" o similar → esEntradaSalida = "salida".
7. Si no se menciona nada de entrada o salida → esEntradaSalida = "vacio".

Ejemplo de respuesta:
{
  "nombre": "Juan Pérez",
  "lugarTrabajo": "Alfa 1",
  "esEntradaSalida": "entrada"
}

Mensaje:
"${texto}"

Respuesta JSON:
`;

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
      });

      const content = completion.choices[0]?.message?.content || '';
      const json = JSON.parse(content || '{}');
      return json;
    } catch (error) {
      console.error(
        '❌ Error extrayendo nombre, lugar de trabajo y si es entrada/salida:',
        error.message,
      );
      return {};
    }
  }
}
