import { Injectable, OnModuleInit } from '@nestjs/common';
import { Client, Message, MessageMedia } from 'whatsapp-web.js';
import * as QRCode from 'qrcode';
import { BotSynergysService } from 'src/botsynergys/botsynergys.service';
import { QuestionsService } from '../questions/questions.service';
import { MessageVDto } from '../venom/messagev.dto';
import { SendImageDto } from './send-image.dto';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  createWriteStream,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import PDFDocument = require('pdfkit');
import { ImageAnalysisService } from 'src/image-analysis/image-analysis.service';
import { GptVisionService } from 'src/gpt-vision/gpt-vision.service';
import { ChatGptTextService } from 'src/chatgpt-text/chatgpt-text.service';
import { GoogleDriveService } from 'src/google-drive/google-drive.service';
import { DropboxService } from 'src/dropbox/dropbox.service';
import { OpenAiService } from 'src/ia/openai.service';
import { remove as removeAccents } from 'diacritics';

interface QueuedMessage {
  messageDto: MessageVDto;
  timestamp: number;
  attempts: number;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

@Injectable()
export class WwebjsService implements OnModuleInit {
  private client: Client;
  private isConnected = false;
  private connectionState: string = 'DISCONNECTED';
  private currentQr: string | null = null;
  private currentQrUpdatedAt = 0;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private messageQueue: QueuedMessage[] = [];
  private isReconnecting = false;
  private lastConnectionTime = 0;
  private connectionStableTime = 5000; // 5 segundos para considerar conexión estable
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private lastHeartbeat = 0;
  private heartbeatFailures = 0;
  private maxHeartbeatFailures = 3;
  private readonly allowedResponderNumber = '5493835404743';

  constructor(
    private readonly botService: BotSynergysService,
    private readonly questionsService: QuestionsService,
    private readonly imageAnalysisService: ImageAnalysisService,
    private readonly gptVisionService: GptVisionService,
    private readonly chatGptTextService: ChatGptTextService,
    private readonly googleDriveService: GoogleDriveService,
    private readonly dropboxService: DropboxService,
    private readonly openAiService: OpenAiService,
  ) {}

  async onModuleInit() {
    try {
      console.log('🚀 Inicializando cliente de WhatsApp Web.js...');
      await this.initializeWWebJS();
    } catch (error) {
      console.error('❌ Error inicializando WhatsApp Web.js:', error);
      throw error;
    }
  }

  private async initializeWWebJS() {
    try {
      // Crear directorio para sesión si no existe
      const sessionDir = '/data/wwebjs_auth';
      if (!existsSync(sessionDir)) {
        mkdirSync(sessionDir, { recursive: true });
      }

      // Configurar cliente con opciones optimizadas
      this.client = new Client({
        authStrategy: new (require('whatsapp-web.js').LocalAuth)({
          dataPath: sessionDir,
        }),
        // Forzar versión fresca para evitar bucle de autenticación
        webVersionCache: {
          type: 'none',
        },
        puppeteer: {
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            // Usar un User-Agent moderno para evitar bloqueos
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          ],
        },
        qrMaxRetries: 0,
        takeoverOnConflict: true,
        takeoverTimeoutMs: 30000,
      });

      // Configurar eventos
      this.setupEventHandlers();

      // Inicializar cliente
      await this.client.initialize();
    } catch (error) {
      console.error('❌ Error en initializeWWebJS:', error);
      this.scheduleReconnect(5000);
    }
  }

  private setupEventHandlers() {
    this.client.on('qr', async (qr) => {
      try {
        this.currentQr = await QRCode.toDataURL(qr, {
          width: 512,
          margin: 2,
          errorCorrectionLevel: 'M',
        });
        this.currentQrUpdatedAt = Date.now();
        console.log('📱 Código QR generado (base64 en memoria)');
      } catch (error) {
        console.error('❌ Error generando QR base64:', error);
      }
    });

    // Evento de carga de pantalla
    this.client.on('loading_screen', (percent, message) => {
      console.log('⏳ Cargando WhatsApp Web:', percent, '%', message);
    });

    // Evento de cliente listo
    this.client.on('ready', () => {
      console.log('✅ Cliente WhatsApp Web.js conectado exitosamente!');
      this.isConnected = true;
      this.connectionState = 'CONNECTED';
      this.currentQr = null;
      this.currentQrUpdatedAt = 0;
      this.lastConnectionTime = Date.now();
      this.reconnectAttempts = 0;
      this.isReconnecting = false;

      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }

      this.processMessageQueue();
      this.startHeartbeat();
    });

    // Evento de autenticación exitosa
    this.client.on('authenticated', () => {
      console.log('🔐 Cliente autenticado correctamente');

      // Watchdog: Si no llega a READY en 60 segundos, reiniciar
      setTimeout(async () => {
        if (!this.isConnected) {
          console.error(
            '🚨 ALERTA: El cliente se quedó pegado en "Authenticated" sin llegar a "Ready". Forzando reinicio...',
          );
          try {
            await this.client.destroy();
          } catch (e) {
            console.error('Error destruyendo cliente:', e);
          }
          this.initializeWWebJS();
        }
      }, 60000);
    });

    // Evento de fallo de autenticación
    this.client.on('auth_failure', (msg) => {
      console.error('❌ Fallo de autenticación:', msg);
      this.currentQr = null;
      this.currentQrUpdatedAt = 0;
      this.handleDisconnection('AUTH_FAILURE');
    });

    // Evento de desconexión
    this.client.on('disconnected', (reason) => {
      console.log('🔌 Cliente desconectado:', reason);
      this.isConnected = false;
      this.connectionState = 'DISCONNECTED';
      this.currentQr = null;
      this.currentQrUpdatedAt = 0;
      this.handleDisconnection(reason);
    });

    // Evento de mensajes
    this.client.on('message_create', async (message) => {
      await this.handleIncomingMessage(message);
    });

    // Evento de cambio de estado
    this.client.on('change_state', (state) => {
      console.log('🔄 Cambio de estado:', state);
      this.connectionState = state;
    });
  }

  getQr(): { status: string; qr: string | null } {
    if (this.currentQr) {
      return { status: 'ready', qr: this.currentQr };
    }

    if (this.isConnected) {
      return { status: 'connected', qr: null };
    }

    return { status: this.connectionState || 'disconnected', qr: null };
  }

  private handleDisconnection(reason: string) {
    this.stopHeartbeat();

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      const delay = this.calculateReconnectDelay(reason);
      console.log(
        `⏳ Intento de reconexión ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts} en ${delay / 1000} segundos...`,
      );
      this.handleReconnection(reason);
    } else {
      console.log('❌ Máximo número de intentos de reconexión alcanzado');
      this.clearMessageQueue(
        'Máximo número de intentos de reconexión alcanzado',
      );
    }
  }

  private handleReconnection(reason: string) {
    if (this.isReconnecting) {
      console.log('⏳ Ya hay una reconexión en progreso...');
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;

    const reconnectDelay = this.calculateReconnectDelay(reason);
    this.scheduleReconnect(reconnectDelay);
  }

  private calculateReconnectDelay(reason: string): number {
    const baseDelay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts - 1),
      30000,
    );

    switch (reason) {
      case 'NAVIGATION':
      case 'TIMEOUT':
        console.log(
          '⚠️ Error de navegación/timeout, reconectando rápidamente...',
        );
        return Math.max(baseDelay, 5000); // 5 segundos
      case 'AUTH_FAILURE':
        console.log('⚠️ Fallo de autenticación, esperando más tiempo...');
        return Math.max(baseDelay, 25000); // 25 segundos
      case 'CONFLICT':
        console.log('⚠️ Conflicto de sesión, esperando...');
        return Math.max(baseDelay, 15000); // 15 segundos
      default:
        console.log('⚠️ Desconexión genérica');
        return baseDelay;
    }
  }

  private scheduleReconnect(delay: number) {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectTimeout = setTimeout(async () => {
      try {
        console.log('🔄 Iniciando reconexión...');
        if (this.client) {
          try {
            await this.client.destroy();
          } catch (e) {
            // Ignoramos error al destruir cliente si ya está cerrado
          }
        }
        await this.initializeWWebJS();
      } catch (error) {
        console.error('❌ Error durante la reconexión:', error);
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.scheduleReconnect(5000);
        }
      }
    }, delay);
  }

  private async handleIncomingMessage(message: Message) {
    try {
      // Ignorar mensajes propios y de estado
      if (message.fromMe || message.from === 'status@broadcast') {
        return;
      }

      if (!this.isAuthorizedChatId(message.from)) {
        return;
      }

      console.log('📨 Mensaje recibido de:', message.from);

      const messageContent = message.body || 'Mensaje multimedia';

      if (!messageContent) {
        console.log('⏭️ Mensaje ignorado (sin contenido válido)');
        return;
      }

      console.log('✅ Procesando mensaje:', {
        from: message.from,
        isGroup: message.from.includes('@g.us'),
        content: messageContent.substring(0, 50) + '...',
      });

      if (message.from.includes('@g.us')) {
        await this.handleGroupMessage(message, messageContent);
      } else {
        await this.handleIndividualMessage(message, messageContent);
      }
    } catch (error) {
      console.error('❌ Error procesando mensaje:', error);
    }
  }

  private async handleGroupMessage(message: Message, messageContent: string) {
    const targetMention = '32397642989644@c.us';
    const allowedGroups = [
      '120363422110552517@g.us', // Grupo original
      '120363418511991684@g.us', // Descomenta y agrega el nuevo ID aquí
    ];

    const isCorrectGroup = allowedGroups.includes(message.from);
    // Verificar menciones
    const mentions = message.mentionedIds || [];
    const isMentioned = mentions.some((id) => id.includes('32397642989644'));

    // Si mencionan al bot y piden el código del grupo, responder siempre con el ID del grupo
    // Normalizar acentos, minúsculas y espacios múltiples
    const normalizedContent = removeAccents(messageContent || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    // Aceptar ambas variantes: "codigo del grupo" y "codigo de grupo"
    const groupCodeKeywords = ['codigo del grupo', 'codigo de grupo'];
    const asksGroupCode = groupCodeKeywords.some((k) =>
      normalizedContent.includes(k),
    );

    if (isMentioned && asksGroupCode) {
      const respuestaCodigo = `🆔 ID del grupo: ${message.from}`;
      const savedCodigo = await this.saveMessage(message, messageContent);
      await this.sendMessage({
        messageTo: message.from,
        questionText: respuestaCodigo,
      });
      await this.questionsService.updateResponse(
        savedCodigo.id,
        respuestaCodigo,
      );
      return; // No continuar con la validación de grupos permitidos
    }

    if (!isMentioned || !isCorrectGroup) return;

    const saved = await this.saveMessage(message, messageContent);
    const respuesta = await this.botService.responder(messageContent);

    await this.sendMessage({
      messageTo: message.from,
      questionText: respuesta,
    });

    await this.questionsService.updateResponse(saved.id, respuesta);
  }

  private intentosFallidos: Record<string, number> = {};

  private async handleIndividualMessage(
    message: Message,
    messageContent: string,
  ) {
    const sender = message.from;

    try {
      if (!this.isAuthorizedChatId(sender)) {
        return;
      }

      const saved = await this.saveMessage(message, messageContent);

      // Verificar si es una imagen
      if (message.hasMedia && message.type === 'image') {
        await this.handleImageMessage(message, sender, saved.id);
        return;
      }

      // Verificar si es audio (ptt o audio) y si es el número autorizado
      if (
        message.hasMedia &&
        (message.type === 'ptt' || message.type === 'audio')
      ) {
        // Normalizar el número para verificar (eliminar @c.us si existe)
        const cleanSender = sender.replace('@c.us', '').replace(' ', '');
        if (cleanSender === this.allowedResponderNumber) {
          await this.handleAudioMessage(message, sender);
          return;
        }
      }

      // Procesar mensaje de texto
      const respuesta = await this.botService.responder(messageContent);

      await this.sendMessage({
        messageTo: sender,
        questionText: respuesta,
      });

      await this.questionsService.updateResponse(saved.id, respuesta);

      // Resetear intentos fallidos
      delete this.intentosFallidos[sender];
    } catch (error) {
      console.error('❌ Error en handleIndividualMessage:', error);

      // Manejar intentos fallidos
      this.intentosFallidos[sender] = (this.intentosFallidos[sender] || 0) + 1;

      if (this.intentosFallidos[sender] <= 3) {
        await this.sendMessage({
          messageTo: sender,
          questionText:
            'Lo siento, hubo un error procesando tu mensaje. Por favor, inténtalo de nuevo.',
        });
      }
    }
  }

  private async handleAudioMessage(message: Message, sender: string) {
    let tempPdfPath: string | null = null;
    try {
      console.log('🎤 Procesando mensaje de audio...');

      await this.sendMessage({
        messageTo: sender,
        questionText: '🎤 Procesando audio, por favor espera...',
      });

      // Descargar el audio
      const media = await this.downloadMediaCustom(message);

      if (!media) {
        throw new Error('No se pudo descargar el audio');
      }

      // Convertir base64 a buffer
      const buffer = Buffer.from(media.data, 'base64');

      // Transcribir con OpenAI Whisper
      const rawTranscription = await this.openAiService.transcribeAudio(buffer);
      console.log('📝 Transcripción raw obtenida:', rawTranscription);

      // Formatear texto con GPT para agregar saltos de línea en nombres
      const prompt = `Formatea el siguiente texto de una transcripción. Identifica los nombres de personas (masculinos o femeninos) y agrega un salto de línea (punto y aparte) antes de cada nombre para separar los diálogos o menciones y mejorar la lectura.
      
      Texto original:
      "${rawTranscription}"
      
      Devuelve SOLO el texto formateado, sin comentarios adicionales. Por favor quita todo lo que no sea el texto formateado. Como este texto que estabas agregando al final: Subtítulos realizados por la comunidad de Amara.org`;

      const formattedTranscription = await this.openAiService.consultar(
        prompt,
        'gpt-3.5-turbo',
      );
      console.log('📝 Transcripción formateada:', formattedTranscription);

      // Enviar respuesta de texto
      await this.sendMessage({
        messageTo: sender,
        questionText: `📝 *Transcripción del audio:*\n\n${formattedTranscription}`,
      });

      // Generar PDF
      const fileName = `transcription-${Date.now()}.pdf`;
      tempPdfPath = join('./uploads', fileName);

      // Asegurar que el directorio uploads existe
      if (!existsSync('./uploads')) {
        mkdirSync('./uploads', { recursive: true });
      }

      await this.generatePdf(formattedTranscription, tempPdfPath);

      // Enviar PDF
      const pdfMedia = MessageMedia.fromFilePath(tempPdfPath);
      await this.client.sendMessage(sender, pdfMedia, {
        caption: '📄 Aquí tienes la transcripción en PDF.',
      });
    } catch (error) {
      console.error('❌ Error procesando audio:', error);
      await this.sendMessage({
        messageTo: sender,
        questionText:
          '⚠️ Hubo un error al procesar el audio. Por favor intenta enviarlo nuevamente.',
      });
    } finally {
      // Limpiar archivo PDF temporal
      if (tempPdfPath && existsSync(tempPdfPath)) {
        try {
          unlinkSync(tempPdfPath);
        } catch (e) {
          console.error('Error eliminando archivo temporal:', e);
        }
      }
    }
  }

  private async generatePdf(text: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument();
        const stream = createWriteStream(outputPath);

        doc.pipe(stream);

        doc.fontSize(12).text(text, {
          align: 'left',
        });

        doc.end();

        stream.on('finish', () => resolve());
        stream.on('error', (err) => reject(err));
      } catch (error) {
        reject(error);
      }
    });
  }

  private async downloadMediaCustom(
    message: Message,
  ): Promise<MessageMedia | undefined> {
    try {
      return await message.downloadMedia();
    } catch (error) {
      console.log('⚠️ Error en downloadMedia nativo:', error.message);

      // Intento de recuperación si falla el método nativo
      try {
        if (this.client && this.client.pupPage) {
          // @ts-ignore
          const result = await this.client.pupPage.evaluate(async (msgId) => {
            try {
              // @ts-ignore
              const msg = window.Store.Msg.get(msgId);
              if (!msg) return null;

              // Forzar descarga
              if (msg.mediaData.mediaStage !== 'RESOLVED') {
                await msg.downloadMedia({
                  downloadEvenIfExpensive: true,
                  rmrLevel: 1,
                });
              }

              if (msg.mediaData.mediaStage !== 'RESOLVED') {
                return null;
              }

              // Intentar obtener datos usando WWebJS si está disponible
              // @ts-ignore
              const mediaData = await window.WWebJS.getMediaData(msg);
              return mediaData;
            } catch (e) {
              return null;
            }
          }, message.id._serialized);

          if (result) {
            return new MessageMedia(
              result.mimetype,
              result.data,
              result.filename,
            );
          }
        }
      } catch (e) {
        console.error('❌ Error en fallback de descarga:', e);
      }

      return undefined;
    }
  }

  private async handleImageMessage(
    message: Message,
    sender: string,
    savedMessageId: number,
  ) {
    try {
      console.log('🖼️ Procesando imagen...');

      // Descargar la imagen usando método personalizado
      const media = await this.downloadMediaCustom(message);

      if (!media) {
        throw new Error('No se pudo descargar la imagen');
      }

      await this.sendMessage({
        messageTo: sender,
        questionText: '📸 Estoy procesando la imagen...',
      });

      await this.sendMessage({
        messageTo: sender,
        questionText:
          'Solo unos segundos más mientras registro tu asistencia ⏳',
      });

      let nombre = '';
      let vehiculo = '';
      let esEntradaSalida = '';

      // Extraer caption de la imagen
      const safeTextoImagen = message.body || '';
      console.log('🧾 Texto extraído:', safeTextoImagen);

      if (safeTextoImagen) {
        const datosTexto =
          await this.chatGptTextService.extraerNombreVehiculo(safeTextoImagen);
        console.log('Datos Texto: ', datosTexto);
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
        await this.sendMessage({
          messageTo: sender,
          questionText:
            '⚠️ No logré encontrar si es entrada/salida, el nombre y el lugar de trabajo en el texto que acompañaste con la imagen.',
        });

        await this.sendMessage({
          messageTo: sender,
          questionText:
            '¿Podrías enviarme la foto nuevamente, asegurándote de acompañarla con el texto que vean el si es entrada/salida, el nombre y el lugar de trabajo?',
        });

        return;
      }

      // Guardar imagen
      const fecha = new Date().toISOString().split('T')[0];
      const nombreArchivo = `foto_${this.sanitizeFileName(nombre)}_${Date.now()}.jpg`;
      const ruta = join('./uploads', fecha);

      if (!existsSync(ruta)) mkdirSync(ruta, { recursive: true });
      const fullPath = join(ruta, nombreArchivo);

      // Convertir base64 a buffer y guardar
      const buffer = Buffer.from(media.data, 'base64');
      writeFileSync(fullPath, buffer);
      console.log(`📷 Imagen guardada: ${fullPath}`);

      // Análisis de imagen simplificado
      const analysis = {
        faceDetected: false,
        date: null,
        lat: null,
        lng: null,
      };

      const userKey = sender;
      const datosIncompletos = !analysis.date || !analysis.lat || !analysis.lng;

      if (datosIncompletos) {
        this.intentosFallidos[userKey] =
          (this.intentosFallidos[userKey] || 0) + 1;

        if (this.intentosFallidos[userKey] >= 1) {
          // Escalar a GPT Vision
          console.warn('🔎 Imagen enviada a revisión:', fullPath);
          const gptVisionResponse = await this.gptVisionService.revisarImagen(
            fullPath,
            sender,
          );
          console.log('🚀 Respuesta de GPT Vision:', gptVisionResponse);

          const { date } = gptVisionResponse;
          const lat = parseFloat(gptVisionResponse.lat || '-37.3870416');
          const lng = parseFloat(gptVisionResponse.lng || '-59.1299733');

          if (date && lat && lng) {
            // Validar antigüedad de 72hs
            const [datePart, timePart] = date.split(' ');
            if (datePart) {
              const parts = datePart.split('/');
              if (parts.length === 3) {
                const day = parseInt(parts[0], 10);
                const month = parseInt(parts[1], 10) - 1; // Meses en JS son 0-11
                const year = parseInt(parts[2], 10);

                let hour = 0,
                  minute = 0,
                  second = 0;
                if (timePart) {
                  const timeParts = timePart.split(':');
                  if (timeParts.length >= 2) {
                    hour = parseInt(timeParts[0], 10);
                    minute = parseInt(timeParts[1], 10);
                    second = timeParts[2] ? parseInt(timeParts[2], 10) : 0;
                  }
                }

                const imageDate = new Date(
                  year,
                  month,
                  day,
                  hour,
                  minute,
                  second,
                );
                const now = new Date();
                const diffMs = now.getTime() - imageDate.getTime();
                const diffHours = diffMs / (1000 * 60 * 60);

                console.log(
                  `🕒 Antigüedad de la imagen: ${diffHours.toFixed(2)} horas`,
                );

                if (diffHours > 72) {
                  console.warn(
                    '⚠️ Selfie rechazada por antigüedad mayor a 72hs',
                  );
                  await this.sendMessage({
                    messageTo: sender,
                    questionText:
                      '⚠️ La fecha enviada en la selfie no pudo ser leída correctamente. Por favor, enviá nuevamente la asistencia con una nueva selfie en donde se vea mejor la fecha y hora, gracias!',
                  });
                  return;
                }
              }
            }

            this.intentosFallidos[userKey] = 0;
            const numeroWhatsapp = sender.split('@')[0];
            const faceDetected = gptVisionResponse.faceDetected;

            // Enviar foto a Dropbox
            console.log('✅ Enviando imagen a Dropbox');
            const link = await this.dropboxService.uploadFile(
              fullPath,
              nombreArchivo,
              vehiculo || 'no identificado',
            );
            console.log('✅ Imagen enviada a Dropbox link:', link);

            const mensajeConfirmacion = `✅ ¡Asistencia registrada con éxito!\n🗓 Fecha: ${date}\n📍 Tipo de asistencia: ${esEntradaSalida || 'No especificado'}\n🧑‍🦱 Rostro detectado: ${faceDetected ? 'Sí' : 'No'}\n👤 Nombre: ${nombre || 'No identificado'}\n🚑 Lugar de Trabajo: ${vehiculo || 'No identificado'}\n📌 Gracias por confirmar tu asistencia.`;

            await this.sendMessage({
              messageTo: sender,
              questionText: mensajeConfirmacion,
            });

            const respuesta = await this.botService.responderImg(
              numeroWhatsapp,
              date,
              lat.toString(),
              lng.toString(),
              faceDetected ? 'yes' : 'no',
              link,
              nombre,
              vehiculo,
              esEntradaSalida,
              safeTextoImagen,
            );

            await this.questionsService.updateResponse(
              savedMessageId,
              respuesta,
            );
          } else {
            await this.sendMessage({
              messageTo: sender,
              questionText:
                '⚠️ No pude extraer la información de la imagen. Será revisada manualmente. Por favor, enviá la imagen con posición y fecha.',
            });
          }

          this.intentosFallidos[userKey] = 0;
        } else {
          await this.sendMessage({
            messageTo: sender,
            questionText:
              '⚠️ No logré identificar bien la fecha o las coordenadas en la imagen.',
          });

          await this.sendMessage({
            messageTo: sender,
            questionText:
              '¿Podrías enviarme otra foto un poquito más clara, por favor?',
          });
        }

        return;
      }
    } catch (error) {
      console.error('❌ Error procesando imagen:', error);
      await this.sendMessage({
        messageTo: sender,
        questionText:
          'Lo siento, no pude procesar la imagen. Por favor, inténtalo de nuevo.',
      });
    }
  }

  private sanitizeFileName(nombre: string) {
    const sinAcentos = removeAccents(nombre);
    return sinAcentos.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  private async saveMessage(message: Message, content: string) {
    const messageData = {
      questionText: content,
      messageFrom: message.from,
      messageTo: '',
      isGroupMsg: message.from.includes('@g.us') || false,
      platform: 'wwebjs',
    };

    return await this.questionsService.saveWithoutResponse(messageData);
  }

  async sendMessage(messageDto: MessageVDto): Promise<string> {
    try {
      /* if (!this.isAuthorizedChatId(messageDto.messageTo)) {
        return 'Destinatario no autorizado';
      } */

      if (!this.isConnectionReady()) {
        console.log(
          '⚠️ Conexión no disponible, agregando mensaje a la cola...',
        );
        return await this.queueMessage(messageDto);
      }

      return await this.sendMessageDirect(messageDto);
    } catch (error) {
      console.error('❌ Error enviando mensaje:', error);

      if (this.isConnectionError(error)) {
        console.log(
          '⚠️ Error de conexión detectado, agregando mensaje a la cola...',
        );
        return await this.queueMessage(messageDto);
      }

      throw new Error('Error enviando mensaje: ' + error.message);
    }
  }

  private async sendMessageDirect(messageDto: MessageVDto): Promise<string> {
    try {
      if (!this.client || !this.isConnected) {
        throw new Error('Cliente no conectado');
      }

      await this.client.sendMessage(
        messageDto.messageTo,
        messageDto.questionText,
        { sendSeen: false },
      );
      console.log(
        '✅ Mensaje enviado directamente:',
        messageDto.questionText.substring(0, 50) + '...',
      );
      return 'Mensaje enviado correctamente';
    } catch (error) {
      console.error('❌ Error en sendMessageDirect:', error);
      throw error;
    }
  }

  // === Envío de imágenes ===
  async sendImage(dto: SendImageDto): Promise<string> {
    try {
      if (!this.isAuthorizedChatId(dto.messageTo)) {
        return 'Destinatario no autorizado';
      }

      if (!this.isConnectionReady()) {
        throw new Error('Cliente no conectado');
      }

      const { mime, data } = this.parseBase64Image(dto.imageBase64);
      const ext = (mime.split('/')[1] || 'png').toLowerCase();
      const filename = `image_${Date.now()}.${ext}`;
      const media = new MessageMedia(mime, data, filename);

      await this.client.sendMessage(dto.messageTo, media, {
        caption: dto.caption || '',
        sendSeen: false,
      });
      console.log(
        '✅ Imagen enviada a',
        dto.messageTo,
        'con caption:',
        (dto.caption || '').substring(0, 50),
      );
      return 'Imagen enviada correctamente';
    } catch (error) {
      console.error('❌ Error enviando imagen:', error);
      throw new Error('Error enviando imagen: ' + error.message);
    }
  }

  private parseBase64Image(input: string): { mime: string; data: string } {
    if (!input) {
      throw new Error('imageBase64 vacío');
    }

    if (input.startsWith('data:')) {
      const match = input.match(/^data:(.+);base64,(.+)$/);
      if (!match || match.length < 3) {
        throw new Error('Formato de data URL inválido');
      }
      return { mime: match[1], data: match[2] };
    }

    // Base64 puro, usar por defecto PNG
    return { mime: 'image/png', data: input };
  }

  private isAuthorizedChatId(chatId: string): boolean {
    if (!chatId) {
      return false;
    }

    const base = chatId.includes('@') ? chatId.split('@')[0] : chatId;
    const digits = base.replace(/\D/g, '');
    return digits === this.allowedResponderNumber;
  }

  private isConnectionReady(): boolean {
    const isBasicConnectionOk =
      this.isConnected && this.client && this.connectionState === 'CONNECTED';

    if (!isBasicConnectionOk) {
      return false;
    }

    const connectionAge = Date.now() - this.lastConnectionTime;
    const isStable = connectionAge > this.connectionStableTime;

    if (!isStable) {
      console.log(
        `⏳ Conexión muy reciente (${connectionAge}ms), esperando estabilidad...`,
      );
      return false;
    }

    return true;
  }

  private isConnectionError(error: any): boolean {
    const errorMessage = error.message?.toLowerCase() || '';
    const connectionErrors = [
      'cliente no conectado',
      'connection closed',
      'connection lost',
      'not connected',
      'disconnected',
      'timeout',
      'session closed',
    ];

    return connectionErrors.some((errorType) =>
      errorMessage.includes(errorType),
    );
  }

  private async queueMessage(messageDto: MessageVDto): Promise<string> {
    return new Promise((resolve, reject) => {
      const queuedMessage: QueuedMessage = {
        messageDto,
        timestamp: Date.now(),
        attempts: 0,
        resolve,
        reject,
      };

      this.messageQueue.push(queuedMessage);
      console.log(
        `📥 Mensaje agregado a la cola (${this.messageQueue.length} mensajes pendientes)`,
      );

      if (!this.isReconnecting && !this.isConnected) {
        console.log('🔄 Iniciando reconexión debido a mensaje en cola...');
        this.handleReconnection('QUEUE_TRIGGER');
      }
    });
  }

  private async processMessageQueue() {
    if (this.messageQueue.length === 0) {
      return;
    }

    console.log(
      `📤 Procesando cola de mensajes (${this.messageQueue.length} mensajes pendientes)...`,
    );

    const messagesToProcess = [...this.messageQueue];
    this.messageQueue = [];

    for (const queuedMessage of messagesToProcess) {
      try {
        if (Date.now() - queuedMessage.timestamp > 300000) {
          // 5 minutos
          queuedMessage.reject(
            new Error('Mensaje expirado (más de 5 minutos en cola)'),
          );
          continue;
        }

        const result = await this.sendMessageDirect(queuedMessage.messageDto);
        queuedMessage.resolve(result);

        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        queuedMessage.attempts++;

        if (queuedMessage.attempts >= 3) {
          queuedMessage.reject(
            new Error(
              `Mensaje falló después de ${queuedMessage.attempts} intentos: ${error.message}`,
            ),
          );
        } else {
          console.log(
            `⚠️ Reintentando mensaje (intento ${queuedMessage.attempts + 1}/3)...`,
          );
          this.messageQueue.push(queuedMessage);
        }
      }
    }
  }

  private clearMessageQueue(reason: string) {
    console.log(
      `🗑️ Limpiando cola de mensajes (${this.messageQueue.length} mensajes): ${reason}`,
    );

    this.messageQueue.forEach((queuedMessage) => {
      queuedMessage.reject(new Error(`Mensaje no enviado: ${reason}`));
    });

    this.messageQueue = [];
  }

  // Sistema de Heartbeat
  private startHeartbeat() {
    console.log('💓 Iniciando sistema de heartbeat...');

    this.stopHeartbeat();
    this.lastHeartbeat = Date.now();
    this.heartbeatFailures = 0;

    this.heartbeatInterval = setInterval(async () => {
      await this.performHeartbeat();
    }, 30000); // Heartbeat cada 30 segundos
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      console.log('💓 Sistema de heartbeat detenido');
    }
  }

  private async performHeartbeat() {
    try {
      if (!this.client || !this.isConnected) {
        console.log('💔 Heartbeat falló: no hay conexión');
        this.handleHeartbeatFailure();
        return;
      }

      // Verificar estado del cliente
      const state = await this.client.getState();
      if (state !== 'CONNECTED') {
        console.log('💔 Heartbeat falló: estado no conectado -', state);
        this.handleHeartbeatFailure();
        return;
      }

      if (!this.isConnectionReady()) {
        console.log('💔 Heartbeat falló: conexión no estable');
        this.handleHeartbeatFailure();
        return;
      }

      this.lastHeartbeat = Date.now();
      this.heartbeatFailures = 0;
      console.log('💚 Heartbeat exitoso - Conexión activa');
    } catch (error) {
      console.error('💔 Error en heartbeat:', error);
      this.handleHeartbeatFailure();
    }
  }

  private handleHeartbeatFailure() {
    this.heartbeatFailures++;
    console.log(
      `💔 Fallo de heartbeat ${this.heartbeatFailures}/${this.maxHeartbeatFailures}`,
    );

    if (this.heartbeatFailures >= this.maxHeartbeatFailures) {
      console.log(
        '💀 Máximo de fallos de heartbeat alcanzado, forzando reconexión...',
      );
      this.stopHeartbeat();

      this.isConnected = false;
      this.connectionState = 'DISCONNECTED';

      if (!this.isReconnecting) {
        this.handleReconnection('HEARTBEAT_FAILURE');
      }
    }
  }

  // Métodos de control
  async testConnection(): Promise<boolean> {
    try {
      if (!this.client || !this.isConnected) {
        console.log(
          '❌ Test de conexión falló: cliente o conexión no disponible',
        );
        return false;
      }

      const state = await this.client.getState();
      console.log('📊 Estado del cliente:', state);

      if (!this.isConnectionReady()) {
        console.log('❌ Test de conexión falló: conexión no estable');
        return false;
      }

      console.log('✅ Test de conexión exitoso');
      return true;
    } catch (error) {
      console.error('❌ Error en test de conexión:', error);
      return false;
    }
  }

  async getConnectionStatus(): Promise<any> {
    const connectionAge =
      this.lastConnectionTime > 0 ? Date.now() - this.lastConnectionTime : 0;
    const isStable = connectionAge > this.connectionStableTime;

    let clientState = 'UNKNOWN';
    try {
      if (this.client) {
        clientState = await this.client.getState();
      }
    } catch (error) {
      clientState = 'ERROR';
    }

    return {
      isConnected: this.isConnected,
      connectionState: this.connectionState,
      clientState: clientState,
      isReconnecting: this.isReconnecting,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
      connectionAge: connectionAge,
      isStable: isStable,
      queuedMessages: this.messageQueue.length,
      timestamp: new Date().toISOString(),
    };
  }

  async clearQueue(): Promise<void> {
    this.clearMessageQueue('Limpieza manual de la cola');
  }

  async forceReconnect(): Promise<void> {
    console.log('🔄 Forzando reconexión...');

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.isConnected = false;
    this.connectionState = 'DISCONNECTED';
    this.isReconnecting = false;
    this.reconnectAttempts = 0;

    try {
      await this.client.destroy();
    } catch (error) {
      console.error('❌ Error destruyendo cliente:', error);
    }

    await this.initializeWWebJS();
  }

  async disconnect() {
    console.log('🔌 Iniciando desconexión...');

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.stopHeartbeat();
    this.clearMessageQueue('Desconexión solicitada');

    if (this.client) {
      try {
        await this.client.destroy();
      } catch (error) {
        console.error('❌ Error durante desconexión:', error);
      }

      this.isConnected = false;
      this.connectionState = 'DISCONNECTED';
      this.client = null as any;
      console.log('🔌 Desconectado de WhatsApp Web.js');
    }
  }
}
