import { Injectable } from '@nestjs/common';
import { SheetsService } from '../sheets/sheets.service';
import { LocalAIService } from '../localai/localai.service';
import { OllamaService } from '../ia/ollama.service';
import { QuestionsService } from '../questions/questions.service';
import { OpenAiService } from '../ia/openai.service';

type AmbulanciaInfo = {
  tiene: string[];
  falta: string[];
  vencidas: string[];
  proximas: string[];
  telefonos: string[];
  noAplica: string[];
};

@Injectable()
export class BotSynergysService {
  constructor(
    private readonly sheetsService: SheetsService,
    private readonly localAIService: LocalAIService,
    private readonly ollamaService: OllamaService,
    private readonly questionsService: QuestionsService,
    private readonly openAiService: OpenAiService,
  ) {}

  async responder(mensajeUsuario: string): Promise<string> {
    const saludoDetectado = this.detectarSaludo(mensajeUsuario);
    if (saludoDetectado && mensajeUsuario.length < 11) {
      return `
    👋 ¡Hola! Soy el asistente técnico de Synergys.

    📌 Podés preguntarme cosas como:
    • ¿Qué documentos faltan en la ambulancia X?
    • ¿Hay documentación vencida en alguna unidad?
    • ¿Qué tiene cargado el vehículo X?
    • Listado de vehiculos

    Escribime tu consulta cuando quieras.
      `.trim();
    }

    const datos = await this.sheetsService.leerRango(
      process.env.SHEET_ID,
      'Vehiculos!A1:N210',
    );

    const ambulancias = this.procesarDatos(datos);
    const respuestaNoAplica = this.chequearNoAplica(
      mensajeUsuario,
      ambulancias,
    );
    if (respuestaNoAplica) return respuestaNoAplica;
    const intencion = this.detectarIntencion(mensajeUsuario);
    const resumen = this.generarTexto(ambulancias, intencion);

    const prompt = `
Sos un asistente técnico que responde sobre documentación y equipamiento de ambulancias de la empresa Synergys.

Intención del usuario: ${intencion.toUpperCase()}.

Información disponible:

${resumen}

Respondé en español, de manera clara, específica y profesional.
    `.trim();

    return await this.openAiService.consultar([
      { role: 'system', content: prompt },
      { role: 'user', content: mensajeUsuario },
    ]);
  }

  async responderImg(
    whatsapp: string,
    fecha: string,
    lat: string,
    lng: string,
    faceDetected: string,
    urlImagen: string,
    nombre: string,
    vehiculo: string,
    esEntradaSalida: string,
    msj: string,
  ): Promise<string> {
    function convertirFechaAISO(fechaStr: string): string | null {
      // La fecha viene tipo "17/7/2025 22:36:34"
      const [fechaParte, horaParte] = fechaStr.split(' '); // ["17/7/2025", "22:36:34"]
      if (!fechaParte || !horaParte) return null;

      const [dia, mes, anio] = fechaParte.split('/').map(Number);
      if (!dia || !mes || !anio) return null;

      // Crear objeto Date
      const fecha = new Date(anio, mes - 1, dia);
      if (isNaN(fecha.getTime())) return null;

      // Construir ISO sin zona horaria (ejemplo: 2025-07-17T22:36:34)
      const isoString = `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}-${String(fecha.getDate()).padStart(2, '0')}T${horaParte}`;

      return isoString;
    }

    let fechaISO = convertirFechaAISO(fecha);
    if (!fechaISO) {
      // manejar error de fecha inválida o usar fecha actual
      console.warn('Fecha inválida, se usará fecha actual');
      fechaISO = new Date().toISOString().slice(0, 19);
    }
    faceDetected = faceDetected === 'true' ? 'Sí' : 'No';
    const payload = {
      persona: {
        nombre: nombre || 'Desconocido',
      },
      asistencia: {
        whatsapp: whatsapp,
        ambulancia: vehiculo || 'no identificado',
        fecha: fechaISO,
        latitud: parseFloat(lat),
        longitud: parseFloat(lng),
        observaciones: '',
        imagen_url: urlImagen, // Podés reemplazar esto si tenés una URL dinámica
        msj: msj,
        modo: esEntradaSalida,
      },
    };

    try {
      const axios = require('axios');
      //console.log("Payload final:", JSON.stringify(payload, null, 2));

      const response = await axios.post(
        'https://synergia.synergys.com.ar/api/asistencia',
        payload,
      );
      //console.log('response', response);
      //console.log('✅ Datos enviados correctamente:', response.data);
      return `Asistencia registrada, ${response.data}`;
      //return `✅ Asistencia registrada para ${nombre} con ambulancia ${vehiculo} en modo ${esEntradaSalida}`;
    } catch (error) {
      console.error('❌ Error al enviar datos a la API:', error.message);

      return `⚠️ Error al enviar asistencia: ${error.message}`;
    }
  }

  private async enviarDatosAApiExterna(payload: any) {
    try {
      // Podés usar axios directamente si no estás usando HttpService
      const axios = require('axios');

      const response = await axios.post('https://tu-api.com/endpoint', payload);
      console.log('✅ Datos enviados correctamente:', response.data);
    } catch (error) {
      console.error('❌ Error al enviar datos:', error.message);
    }
  }

  private detectarSaludo(texto: string): boolean {
    const saludoRegex = /\b(hola|buen[oa]s?\s?(d[ií]as|tardes|noches)?)\b/i;
    return saludoRegex.test(texto);
  }

  private detectarIntencion(
    texto: string,
  ): 'faltantes' | 'vencimientos' | 'telefonos' | 'general' {
    const lower = texto.toLowerCase();
    if (lower.includes('vencim') || lower.includes('vence'))
      return 'vencimientos';
    if (lower.includes('falta') || lower.includes('incompleto'))
      return 'faltantes';
    if (
      lower.includes('tel') ||
      lower.includes('celu') ||
      lower.includes('número')
    )
      return 'telefonos';
    return 'general';
  }

  private procesarDatos(datos: string[][]): Record<string, AmbulanciaInfo> {
    const tipoFila = datos[0]; // Fila 1: Tipo
    const patenteFila = datos[1]; // Fila 2: Patente
    const titularFila = datos[2]; // Fila 3: Titular
    const encabezado = datos[3]; // Fila 4: Rubro, Variable, Unidad, Mínimo, Objetivo, etc.
    const filas = datos.slice(4); // Resto: datos reales de control

    const ambulancias: Record<string, AmbulanciaInfo> = {};

    for (let col = 6; col < encabezado.length; col++) {
      const tipoVehiculo = tipoFila[col]?.trim();
      const patente = patenteFila[col]?.trim();
      const titular = titularFila[col]?.trim();
      //  const nombre = `${tipoVehiculo || 'Vehículo'} ${patente || 'Sin Patente'} - ${titular || 'Sin Titular'}`.trim();
      const nombre = encabezado[col]?.trim();
      /*       const nombre = `${tipoVehiculo} (${patente} - ${titular})`;
       */ ambulancias[nombre] = {
        tiene: [],
        falta: [],
        vencidas: [],
        proximas: [],
        telefonos: [],
        noAplica: [],
      };

      for (const fila of filas) {
        const categoria = fila[0]?.trim();
        const variable = fila[1]?.trim();
        const tipo = fila[2]?.trim();
        const valor = fila[col]?.trim().toUpperCase();

        if (!variable || !tipo) continue;

        const info = ambulancias[nombre];

        // 👉 Ignorar o registrar como "No aplica"
        if (valor === 'N/A') {
          info.noAplica.push(variable);
          continue;
        }

        if (tipo !== 'Fecha') {
          if (valor === 'TRUE') info.tiene.push(variable);
          else if (valor === 'FALSE' || valor === 'NO POSEE' || valor === '')
            info.falta.push(variable);
          else if (/^\d{6,}/.test(valor))
            info.telefonos.push(`${variable}: ${valor}`);
        }

        if (tipo === 'Fecha') {
          const fechaValida = /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(valor);
          if (fechaValida) {
            const [d, m, y] = valor.split('/');
            const fecha = new Date(+y, +m - 1, +d);
            const hoy = new Date();
            const en30 = new Date(hoy);
            en30.setDate(hoy.getDate() + 30);

            if (fecha < hoy) info.vencidas.push(`${variable} (${valor})`);
            else if (fecha <= en30)
              info.proximas.push(`${variable} (${valor})`);
          } else if (valor === 'NO POSEE' || valor === '') {
            info.falta.push(variable);
          }
        }
      }
    }

    return ambulancias;
  }

  private chequearNoAplica(
    mensaje: string,
    ambulancias: Record<string, AmbulanciaInfo>,
  ): string | null {
    const lower = mensaje.toLowerCase();

    for (const [nombre, info] of Object.entries(ambulancias)) {
      // Normalizar el nombre de la ambulancia para poder matchear en el mensaje
      const nombreSimplificado = nombre
        .toLowerCase()
        .replace(/\(.*?\)/g, '')
        .trim();

      // Si el mensaje menciona esta ambulancia
      if (lower.includes(nombreSimplificado)) {
        for (const item of info.noAplica) {
          if (lower.includes(item.toLowerCase())) {
            return `🚫 El elemento **${item}** no aplica para el vehiculo **${nombre}**.`;
          }
        }
      }
    }

    return null;
  }

  private generarTexto(
    ambulancias: Record<string, AmbulanciaInfo>,
    modo: 'faltantes' | 'vencimientos' | 'telefonos' | 'general',
  ): string {
    return Object.entries(ambulancias)
      .map(([nombre, info]) => {
        let resumen = `🚑 ${nombre}:\n`;

        if (modo === 'faltantes') {
          resumen += `❌ Faltan: ${info.falta.join(', ') || 'Ninguno'}\n`;
        } else if (modo === 'vencimientos') {
          resumen += `⌛ Vencidas: ${info.vencidas.join(', ') || 'Ninguna'}\n`;
          resumen += `⏳ Por vencer: ${info.proximas.join(', ') || 'Ninguna'}\n`;
        } else if (modo === 'telefonos') {
          resumen += `📱 Contacto: ${info.telefonos.join(', ') || 'Sin número registrado'}\n`;
        } else {
          resumen += `✅ Tiene: ${info.tiene.join(', ') || 'Nada'}\n`;
          resumen += `❌ Faltan: ${info.falta.join(', ') || 'Nada'}\n`;
          resumen += `⛔ No aplica: ${info.noAplica.join(', ') || 'Ninguno'}\n`;
          resumen += `⌛ Vencidas: ${info.vencidas.join(', ') || 'Ninguna'}\n`;
          resumen += `⏳ Por vencer: ${info.proximas.join(', ') || 'Ninguna'}\n`;
          resumen += `📱 Contacto: ${info.telefonos.join(', ') || 'No registrados'}\n`;
        }

        return resumen;
      })
      .join('\n\n');
  }
}
