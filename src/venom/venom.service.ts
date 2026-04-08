import { Injectable, OnModuleInit } from '@nestjs/common';
import { create, Whatsapp } from 'venom-bot';
import { BotSynergysService } from 'src/botsynergys/botsynergys.service';
import { QuestionsService } from '../questions/questions.service';
import { MessageVDto } from './messagev.dto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ImageAnalysisService } from 'src/image-analysis/image-analysis.service';
import { GptVisionService } from 'src/gpt-vision/gpt-vision.service';
import { ChatGptTextService } from 'src/chatgpt-text/chatgpt-text.service';
import { GoogleDriveService } from 'src/google-drive/google-drive.service';
import { DropboxService } from 'src/dropbox/dropbox.service';
import { remove as removeAccents } from 'diacritics';

@Injectable()
export class VenomService implements OnModuleInit {
  private client: Whatsapp;

  constructor(
    private readonly botService: BotSynergysService,
    private readonly questionsService: QuestionsService,
    private readonly imageAnalysisService: ImageAnalysisService,
    private readonly gptVisionService: GptVisionService,
    private readonly chatGptTextService: ChatGptTextService,
    private readonly googleDriveService: GoogleDriveService,
    private readonly dropboxService: DropboxService,
  ) {}

  async onModuleInit() {
    try {
      console.log('🚀 Inicializando cliente de Venom...');

      this.client = await create({
        session: 'bot-wsp',
        headless: 'new',
        logQR: true,
        statusFind: (statusSession, session) => {
          console.log('📱 Estado de la sesión:', statusSession, session);
        },
      });

      console.log('✅ Cliente de Venom inicializado correctamente');
      console.log('🔍 Verificando estado del cliente:', {
        isConnected: this.client ? 'Sí' : 'No',
        hasOnMessage:
          typeof this.client?.onMessage === 'function' ? 'Sí' : 'No',
      });

      // Verificar conexión
      const connectionState = await this.client.getConnectionState();
      console.log('🌐 Estado de conexión:', connectionState);

      // Esperar a que la conexión esté completamente establecida
      await this.waitForConnection();

      // Configurar listener de mensajes
      console.log('👂 Configurando listener de mensajes...');
      this.client.onMessage(async (message) => {
        try {
          console.log(
            '📨 Mensaje recibido - Tipo:',
            message.type,
            'De:',
            message.from,
          );

          if (
            !message.body ||
            message.from === 'status@broadcast' ||
            message.from.includes('@newsletter')
          ) {
            console.log('⏭️ Mensaje ignorado (sin body, status o newsletter)');
            return;
          }

          console.log('✅ Procesando mensaje:', {
            from: message.from,
            type: message.type,
            isGroup: message.isGroupMsg,
            body: message.body?.substring(0, 50) + '...',
          });

          if (message.isGroupMsg) {
            await this.handleGroupMessage(message);
          } else {
            await this.handleIndividualMessage(message);
          }
        } catch (error) {
          console.error('❌ Error procesando mensaje:', error);
        }
      });

      console.log('✅ Listener de mensajes configurado correctamente');

      // Configurar otros listeners para diagnóstico
      this.client.onStateChange((state) => {
        console.log('🔄 Cambio de estado:', state);
      });

      this.client.onStreamChange((stream) => {
        console.log('📡 Cambio de stream:', stream);
      });
    } catch (error) {
      console.error('❌ Error inicializando Venom:', error);
      throw error;
    }
  }

  private async handleGroupMessage(message: any) {
    //console.log('message Completo: ', message);
    const targetMention = '32397642989644@lid';
    const isMentioned = message.mentionedJidList?.some((jid) =>
      jid.includes(targetMention),
    );
    const isCorrectGroup = message.to === '5491156167168@c.us';

    if (!isMentioned || message.isForwarded || !isCorrectGroup) return;

    const saved = await this.saveMessage(message);

    const respuesta = await this.botService.responder(message.body);
    await this.client.sendText(message.from, respuesta);
    await this.questionsService.updateResponse(saved.id, respuesta);
  }

  private sanitizeFileName(nombre: string) {
    const sinAcentos = removeAccents(nombre); // Rodríguez Agustín -> Rodriguez Agustin
    return sinAcentos.replace(/[^a-zA-Z0-9_-]/g, '_'); // Reemplaza todo lo raro por _
  }

  private intentosFallidos: Record<string, number> = {}; // clave: sender

  private async handleIndividualMessage(message: any) {
    const saved = await this.saveMessage(message);

    if (message.type === 'image') {
      const buffer = await this.client.decryptFile(message);

      if (buffer) {
        await this.client.sendText(
          message.from,
          `📸 Estoy procesando la imagen...`,
        );
        await this.client.sendText(
          message.from,
          'Solo unos segundos más mientras registro tu asistencia ⏳',
        );

        let nombre = '';
        let vehiculo = '';
        let esEntradaSalida = '';

        const safeTextoImagen = message.caption ?? '';
        console.log('🧾 Texto extraído:', safeTextoImagen);

        if (safeTextoImagen) {
          const datosTexto =
            await this.chatGptTextService.extraerNombreVehiculo(
              safeTextoImagen,
            );
          nombre = datosTexto.nombre || '';
          vehiculo = datosTexto.lugarTrabajo || '';
          esEntradaSalida = datosTexto.esEntradaSalida || '';
          console.log(
            '🧾 Si es entrada/salida, el nombre y el lugar de trabajo extraídos:',
            esEntradaSalida,
            nombre,
            vehiculo,
          );
        }

        if (
          (nombre === '' && vehiculo === '') ||
          esEntradaSalida === '' ||
          esEntradaSalida === 'vacio'
        ) {
          await this.client.sendText(
            message.from,
            '⚠️ No logré encontrar si es entrada/salida, el nombre y el lugar de trabajo en el texto de la imagen.',
          );

          await this.client.sendText(
            message.from,
            '¿Podrías enviarme la foto nuevamente, asegurándote de que se vean el si es entrada/salida, el nombre y el lugar de trabajo?',
          );

          return;
        }

        const fecha = new Date().toISOString().split('T')[0];
        const ambulancia = `${vehiculo}`;
        const nombreArchivo = `foto_${this.sanitizeFileName(nombre)}_${Date.now()}.jpg`;
        //const ruta = join('./uploads', ambulancia, fecha);
        const ruta = join('./uploads', fecha);

        if (!existsSync(ruta)) mkdirSync(ruta, { recursive: true });
        const fullPath = join(ruta, nombreArchivo);
        writeFileSync(fullPath, buffer);
        console.log(`📷 Imagen guardada: ${fullPath}`);

        const analysis = await this.imageAnalysisService.analyzeImage(fullPath);

        console.log('🕓 Fecha de la foto:', analysis.date);
        console.log('📍 Coordenadas:', analysis.lat, analysis.lng);
        console.log('🧠 ¿Hay rostro humano?:', analysis.faceDetected);

        const safeDate = analysis.date ?? '';
        const safeLat = analysis.lat ?? '';
        const safeLng = analysis.lng ?? '';
        const safeFaceDetected = analysis.faceDetected ?? '';

        const userKey = message.from;

        const datosIncompletos =
          !analysis.date || !analysis.lat || !analysis.lng;

        if (datosIncompletos) {
          this.intentosFallidos[userKey] =
            (this.intentosFallidos[userKey] || 0) + 1;

          if (this.intentosFallidos[userKey] >= 1) {
            await this.client.sendText(
              message.from,
              '⚠️ Parece que la imagen no se ve del todo clara.',
            );
            await this.client.sendText(
              message.from,
              'Dame solo un momento más, la estoy revisando para darte la respuesta... ⌛',
            );

            // Acá podrías escalar a GPT Vision o registrar para revisión manual
            console.warn('🔎 Imagen enviada a revisión:', fullPath);

            const gptVisionResponse = await this.gptVisionService.revisarImagen(
              fullPath,
              message.from,
            );
            console.log('🚀 Respuesta de GPT Vision:', gptVisionResponse);

            const { date, lat, lng } = gptVisionResponse;

            if (date && lat && lng) {
              // const mensaje = `✅ Imagen revisada correctamente:\n📅 Fecha: ${date}\n📍 Latitud: ${lat}\n📍 Longitud: ${lng}`;
              //  await this.client.sendText(message.from, mensaje);

              this.intentosFallidos[userKey] = 0;
              const numeroWhatsapp = message.from.split('@')[0];
              const faceDetected = gptVisionResponse.faceDetected;

              //enviar  foto a drive
              console.log('✅ Enviando imagen a Dropbox');
              console.log('✅ fullPath:', fullPath);
              console.log('✅ nombreArchivo:', nombreArchivo);
              console.log('✅ vehiculo:', vehiculo);
              const link = await this.dropboxService.uploadFile(
                fullPath,
                nombreArchivo,
                vehiculo || 'no identificado',
              );
              //const link = await this.googleDriveService.uploadFile(fullPath, nombreArchivo, vehiculo);
              console.log('✅ Imagen enviada a Dropbox');
              console.log('✅ link:', link);

              const respuesta = await this.botService.responderImg(
                numeroWhatsapp,
                date,
                lat,
                lng,
                faceDetected ? 'yes' : 'no',
                link,
                nombre,
                vehiculo,
                esEntradaSalida,
                message.caption ?? '',
              );

              const mensajeConfirmacion = `✅ ¡Asistencia registrada con éxito!
                  🗓 Fecha: ${date}
                  📍 Tipo de asistencia: Selfie
                  🧑‍🦱 Rostro detectado: ${faceDetected ? 'Sí' : 'No'}
                  👤 Nombre: ${nombre || 'No identificado'}
                  🚑 Lugar de Trabajo: ${vehiculo || 'No identificado'}
                  📌 Gracias por confirmar tu asistencia.`;

              //📌 Para confirmar su asistencia comunicarse con Coordinación de RRHH para completar su registro en el sistema.
              await this.client.sendText(message.from, mensajeConfirmacion);
              await this.questionsService.updateResponse(saved.id, respuesta);
            } else {
              await this.client.sendText(
                message.from,
                '⚠️ No pude extraer la información de la imagen. Será revisada manualmente. Por favor, enviá la imagen con posición y fecha.',
              );
            }
            // Reiniciar contador después de escalar
            this.intentosFallidos[userKey] = 0;
          } else {
            await this.client.sendText(
              message.from,
              '⚠️ No logré identificar bien la fecha o las coordenadas en la imagen.',
            );

            await this.client.sendText(
              message.from,
              '¿Podrías enviarme otra foto un poquito más clara, por favor?',
            );
          }

          return;
        }

        // Si todo salió bien, reiniciar contador
        this.intentosFallidos[userKey] = 0;
        const numeroWhatsapp = message.from.split('@')[0];

        //enviar  foto a drive
        console.log('✅ Enviando imagen a Dropbox');
        console.log('✅ fullPath:', fullPath);
        console.log('✅ nombreArchivo:', nombreArchivo);
        console.log('✅ vehiculo:', vehiculo);
        const link = await this.dropboxService.uploadFile(
          fullPath,
          nombreArchivo,
          vehiculo || 'no identificado',
        );
        //const link = await this.googleDriveService.uploadFile(fullPath, nombreArchivo, vehiculo);
        console.log('✅ Imagen enviada a Dropbox');
        console.log('✅ link:', link);

        const respuesta = await this.botService.responderImg(
          numeroWhatsapp,
          safeDate,
          safeLat.toString(),
          safeLng.toString(),
          safeFaceDetected.toString(),
          link,
          nombre,
          vehiculo,
          esEntradaSalida,
          message.caption ?? '',
        );

        const mensajeConfirmacion = `✅ ¡Asistencia registrada con éxito!
            🗓 Fecha: ${safeDate}
            📍 Tipo de asistencia: Selfie
            🧑‍🦱 Rostro detectado: ${safeFaceDetected ? 'Sí' : 'No'}
            👤 Nombre: ${nombre || 'No identificado'}
            🚑 Lugar de Trabajo: ${vehiculo || 'No identificado'}
            📌 Gracias por confirmar tu asistencia.`;
        //📌 Para confirmar su asistencia comunicarse con Coordinación de RRHH para completar su registro en el sistema.

        await this.client.sendText(message.from, mensajeConfirmacion);
        await this.questionsService.updateResponse(saved.id, respuesta);
      } else {
        console.error('❌ No se pudo descargar la imagen en alta calidad');
      }

      return;
    }

    // Si es texto
    const respuesta = await this.botService.responder(message.body);
    await this.client.sendText(message.from, respuesta);
    await this.questionsService.updateResponse(saved.id, respuesta);
  }

  private async saveMessage(message: any) {
    return this.questionsService.saveWithoutResponse({
      questionText: message.body,
      messageFrom: message.from,
      chatId: message.chatId,
      platform: 'whatsapp',
      timestamp: message.timestamp,
      senderName: message.sender?.pushname,
      senderFormattedName: message.sender?.formattedName,
      isGroupMsg: message.isGroupMsg,
      isMedia: message.isMedia,
      messageType: message.type,
      caption: message.caption,
      filename: message.filename,
      mimetype: message.mimetype,
      clientUrl: message.clientUrl,
      isForwarded: message.isForwarded,
      quotedMsgId: message.quotedMsgObj || '',
    });
  }

  async sendMessage(messageDto: MessageVDto): Promise<string> {
    try {
      await this.client.sendText(messageDto.messageTo, messageDto.questionText);
      return 'mensaje enviado';
    } catch (error) {
      throw new Error(`Error al enviar mensaje: ${error.message}`);
    }
  }

  private async waitForConnection(): Promise<void> {
    console.log('⏳ Esperando conexión completa...');
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts) {
      try {
        const state = await this.client.getConnectionState();
        console.log(
          `🔄 Intento ${attempts + 1}/${maxAttempts} - Estado:`,
          state,
        );

        if (state === 'CONNECTED') {
          console.log('✅ Conexión establecida correctamente');
          // Esperar un poco más para asegurar que todo esté listo
          await new Promise((resolve) => setTimeout(resolve, 2000));
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
        attempts++;
      } catch (error) {
        console.log(
          `⚠️ Error verificando conexión (intento ${attempts + 1}):`,
          error.message,
        );
        attempts++;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    console.warn(
      '⚠️ No se pudo confirmar la conexión después de',
      maxAttempts,
      'intentos',
    );
  }

  async testConnection(): Promise<boolean> {
    try {
      if (!this.client) {
        console.log('❌ Cliente no inicializado');
        return false;
      }

      const state = await this.client.getConnectionState();
      console.log('🧪 Test de conexión - Estado:', state);

      const isConnected = state === 'CONNECTED';
      console.log(
        '🧪 Test de conexión - Resultado:',
        isConnected ? '✅ Conectado' : '❌ No conectado',
      );

      return isConnected;
    } catch (error) {
      console.error('❌ Error en test de conexión:', error);
      return false;
    }
  }

  async getConnectionStatus(): Promise<string> {
    try {
      if (!this.client) {
        return 'Cliente no inicializado';
      }

      const state = await this.client.getConnectionState();
      const isConnected = await this.testConnection();

      return `Estado: ${state} | Conectado: ${isConnected ? 'Sí' : 'No'}`;
    } catch (error) {
      return `Error obteniendo estado: ${error.message}`;
    }
  }
}
