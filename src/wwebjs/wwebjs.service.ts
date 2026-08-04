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
  readdirSync,
  statSync,
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
import axios from 'axios';
import * as nodemailer from 'nodemailer';

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
  private maxHeartbeatFailures = 4; // ~2 min de tolerancia antes de reinicializar
  private readonly allowedResponderNumber = '5493835404743';

  // ── Monitor de salud (alerta por email si el bot no puede enviar/recibir) ──
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private healthFirstCheckTimer: NodeJS.Timeout | null = null;
  private healthLastStatus: 'ok' | 'down' | 'unknown' = 'unknown';
  private healthDownSince = 0;
  private healthLastAlertAt = 0;

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
      this.startHealthMonitor(); // chequeo periódico + alerta por email
      await this.initializeWWebJS();
    } catch (error) {
      console.error('❌ Error inicializando WhatsApp Web.js:', error);
      throw error;
    }
  }

  private cleanChromeLocks(dir: string) {
    try {
      if (!existsSync(dir)) return;
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const full = join(dir, entry);
        if (entry.startsWith('Singleton')) {
          try {
            unlinkSync(full);
            console.log(`🧹 Lock eliminado: ${full}`);
          } catch (e) {
            console.error(`⚠️ No se pudo eliminar ${full}:`, e.message);
          }
          continue;
        }
        try {
          if (statSync(full).isDirectory()) {
            this.cleanChromeLocks(full);
          }
        } catch {
          // Ignorar errores de stat (symlinks rotos, etc.)
        }
      }
    } catch (error) {
      console.error('⚠️ Error limpiando locks de Chrome:', error);
    }
  }

  private async initializeWWebJS() {
    try {
      // Crear directorio para sesión si no existe.
      // Configurable por env: en producción/Railway = '/data/wwebjs_auth'
      // (volumen persistente); en local podés usar p.ej. './wwebjs_auth'.
      const sessionDir = process.env.WWEBJS_SESSION_DIR || '/data/wwebjs_auth';
      if (!existsSync(sessionDir)) {
        mkdirSync(sessionDir, { recursive: true });
      }

      // Limpiar locks de Chrome de crashes anteriores
      this.cleanChromeLocks(sessionDir);

      // Configurar cliente con opciones optimizadas
      this.client = new Client({
        authStrategy: new (require('whatsapp-web.js').LocalAuth)({
          dataPath: sessionDir,
        }),
        puppeteer: {
          headless: true,
          protocolTimeout: 120000,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            // ⚠️ '--single-process' y '--no-zygote' ahorran RAM en contenedores
            // Linux (Railway) pero CRASHEAN Chrome en Windows ("Navigating frame
            // was detached"). Por eso se aplican sólo fuera de Windows.
            ...(process.platform === 'win32'
              ? []
              : ['--no-zygote', '--single-process']),
            '--disable-gpu',
            '--disable-extensions',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
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
      console.error(
        '❌ Error en initializeWWebJS:',
        (error as any)?.message || error,
      );
      // Liberar el flag y reagendar con backoff (no martillar cada 5s, que
      // puede empeorar el throttling de la IP por parte de WhatsApp).
      this.isReconnecting = false;
      this.handleReconnection('TIMEOUT');
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

    // 📡 Acks de entrega/lectura de los mensajes que ENVIAMOS (salientes).
    // ack: -1 error, 0 pending, 1 server(✓), 2 device(✓✓), 3 read(✓✓ azul), 4 played.
    this.client.on('message_ack', (message, ack) => {
      this.forwardAckToLaravel(message, ack).catch((e) =>
        console.error('⚠️ Error reenviando ack a Laravel:', e?.message || e),
      );
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

    // Reintentar SIEMPRE, sin tope: el bot se auto-recupera de cortes de red
    // prolongados (ej. WhatsApp limita la IP del datacenter, o bache de red en
    // Railway) sin necesidad de reinicio/redeploy manual. El backoff de
    // calculateReconnectDelay evita martillar los servidores.
    if (this.reconnectAttempts + 1 >= this.maxReconnectAttempts) {
      console.warn(
        `⚠️ Reconexión: ${this.reconnectAttempts + 1} intentos seguidos (motivo: ${reason}). Sigo reintentando…`,
      );
    } else {
      console.log(
        `⏳ Reconexión programada (motivo: ${reason}, intento ${this.reconnectAttempts + 1})…`,
      );
    }
    this.handleReconnection(reason);
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
      60000, // tope 60s entre intentos durante cortes prolongados
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
        console.error(
          '❌ Error durante la reconexión:',
          (error as any)?.message || error,
        );
        // Reagendar siempre con backoff (auto-recuperación, sin tope).
        this.isReconnecting = false;
        this.handleReconnection('TIMEOUT');
      }
    }, delay);
  }

  private async handleIncomingMessage(message: Message) {
    try {
      // Ignorar mensajes propios y de estado
      if (message.fromMe || message.from === 'status@broadcast') {
        return;
      }

      // 🔁 Reenviar SIEMPRE el mensaje a Laravel (independiente del filtro del
      // bot) para que el estudio contable vea lo que escriben TODOS los
      // clientes Y los grupos. Fire-and-forget: no bloquea ni rompe el flujo.
      this.forwardToLaravel(message).catch((e) =>
        console.error('⚠️ Error reenviando mensaje a Laravel:', e?.message || e),
      );

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
      console.log(
        '⚠️ Error en downloadMedia nativo:',
        error?.stack || error?.message || error,
      );

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

  // ── Reintentos de envío a Laravel ──────────────────────────────────────────
  // El servidor Laravel queda inaccesible a ráfagas (ETIMEDOUT en horario pico);
  // sin reintentos se pierden mensajes entrantes y acks. Esperas: 30s → 2min → 10min.
  private static readonly LARAVEL_RETRY_DELAYS_MS = [30_000, 120_000, 600_000];
  // Tope de reintentos en espera simultáneos: acota la memoria si Laravel está
  // caído un rato largo (los payloads con media pueden pesar varios MB).
  private static readonly LARAVEL_RETRY_MAX_PENDING = 100;
  private laravelRetriesEnEspera = 0;

  /**
   * POST a Laravel con reintentos ante errores de red / HTTP 5xx.
   * Los 4xx NO se reintentan (auth/validación: reintentar no ayuda).
   * Nunca lanza: loguea el resultado y termina (fire-and-forget).
   * Es seguro reintentar: /inbound es idempotente por wa_uid y /ack no degrada.
   */
  private async postLaravelConReintentos(
    path: string,
    buildPayload: () => any | Promise<any>,
    etiqueta: string,
    timeoutMs: number,
  ): Promise<void> {
    const laravelUrl = (process.env.LARAVEL_URL || '').replace(/\/+$/, '');
    if (!laravelUrl) {
      return;
    }
    const apiKey =
      process.env.WA_INBOUND_API_KEY || process.env.CV_IMPORT_API_KEY || '';

    const delays = WwebjsService.LARAVEL_RETRY_DELAYS_MS;
    const maxIntentos = delays.length + 1;

    for (let intento = 1; intento <= maxIntentos; intento++) {
      try {
        // El payload se re-arma en CADA intento. Clave para WhatsApp: la primera
        // vez el contacto puede venir como LID (número aún no sincronizado); al
        // reintentar (30s+ después) ya suele resolver el número real, evitando
        // que en Laravel aparezca un contacto duplicado con el @lid.
        const payload = await buildPayload();
        await axios.post(`${laravelUrl}${path}`, payload, {
          headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
          timeout: timeoutMs,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        });
        if (intento > 1) {
          console.log(
            `✅ ${etiqueta}: entregado a Laravel en el reintento ${intento}/${maxIntentos}`,
          );
        }
        return;
      } catch (e) {
        const status = (e as any)?.response?.status;
        const motivo = status
          ? `HTTP ${status}`
          : (e as any)?.code || (e as any)?.message || 'error de red';
        const esRetryable = !status || status >= 500;

        if (!esRetryable || intento === maxIntentos) {
          console.error(
            `❌ ${etiqueta}: falló definitivamente (intento ${intento}/${maxIntentos}, ${motivo})`,
          );
          return;
        }
        if (
          this.laravelRetriesEnEspera >=
          WwebjsService.LARAVEL_RETRY_MAX_PENDING
        ) {
          console.error(
            `❌ ${etiqueta}: demasiados reintentos en cola (${this.laravelRetriesEnEspera}), se descarta (${motivo})`,
          );
          return;
        }

        const delay = delays[intento - 1];
        console.warn(
          `⚠️ ${etiqueta}: ${motivo} — reintentando en ${Math.round(delay / 1000)}s (intento ${intento}/${maxIntentos})`,
        );
        this.laravelRetriesEnEspera++;
        try {
          await new Promise((r) => setTimeout(r, delay));
        } finally {
          this.laravelRetriesEnEspera--;
        }
      }
    }
  }

  /**
   * Reenvía un mensaje entrante de WhatsApp al backend de Laravel
   * (POST /api/whatsapp/inbound) para que el estudio contable pueda ver el
   * historial de conversaciones de sus clientes. Incluye adjuntos en base64.
   *
   * Config por env:
   *   LARAVEL_URL           ej. http://127.0.0.1:8005  (sin barra final)
   *   WA_INBOUND_API_KEY    (o CV_IMPORT_API_KEY como fallback)
   *
   * Si LARAVEL_URL no está seteada, no hace nada (no rompe el bot).
   */
  private async forwardToLaravel(message: Message): Promise<void> {
    const laravelUrl = (process.env.LARAVEL_URL || '').replace(/\/+$/, '');
    if (!laravelUrl) {
      return;
    }

    // Mapear tipo de whatsapp-web.js al que espera Laravel.
    const rawType = (message.type as string) || 'chat';

    // Ignorar mensajes de SISTEMA / notificaciones (no son mensajes reales).
    // Ej: creación/cambios de grupo (gp2), notificaciones e2e, logs de llamada.
    // Si no, en grupos aparece una "burbuja" vacía cuyo autor es el propio grupo.
    const SYSTEM_TYPES = new Set([
      'gp2',
      'group_notification',
      'notification',
      'notification_template',
      'e2e_notification',
      'call_log',
      'protocol',
      'revoked',
      'ciphertext',
    ]);
    if (SYSTEM_TYPES.has(rawType)) {
      return;
    }

    const tipoMap: Record<string, string> = {
      chat: 'text',
      ptt: 'audio',
      vcard: 'contact',
      multi_vcard: 'contact',
    };
    const tipo = tipoMap[rawType] || rawType;

    // Descargar adjunto (si hay) y mandarlo en base64. Se omiten archivos
    // demasiado grandes para no saturar el request.
    const media: Array<{ mime: string; filename?: string; base64: string }> =
      [];
    try {
      if (message.hasMedia) {
        const m = await this.downloadMediaCustom(message);
        if (m && m.data) {
          const approxBytes = (m.data.length * 3) / 4;
          if (approxBytes <= 18 * 1024 * 1024) {
            media.push({
              mime: m.mimetype,
              filename: m.filename || undefined,
              base64: m.data,
            });
          } else {
            console.warn(
              `⚠️ Adjunto muy grande (${Math.round(approxBytes / 1024 / 1024)}MB), no se reenvía a Laravel`,
            );
          }
        }
      }
    } catch (e) {
      console.error(
        '⚠️ No se pudo descargar el adjunto para Laravel:',
        (e as any)?.message || e,
      );
    }

    const isGroup = message.from.includes('@g.us');
    const waUid = message.id?._serialized;

    // El payload se re-arma en cada intento del reintento (re-resuelve el número
    // LID→teléfono): si la 1ª vez vino como LID, el reintento posterior ya trae
    // el número real y no se duplica el contacto en Laravel. La media se descargó
    // una sola vez (arriba) y se reutiliza.
    const buildPayload = async () => {
      let jid = message.from;
      let telefono = '';
      let nombreWa: string | undefined;
      let authorJid: string | null = null;
      let authorName: string | null = null;

      if (isGroup) {
        // Grupo: distinguir NOMBRE DEL GRUPO (→ nombre_wa) del AUTOR del mensaje
        // (participante → author_name). No usar getContact() para el autor: en
        // grupos a veces devuelve el propio grupo.
        jid = message.from;
        authorJid = ((message as any).author || '').toString() || null;

        try {
          const chat: any = await message.getChat();
          nombreWa = chat?.name || chat?.groupMetadata?.subject || undefined;
        } catch {
          /* sin chat */
        }
        if (!nombreWa) {
          try {
            const chat2: any = await this.client.getChatById(message.from);
            nombreWa = chat2?.name || chat2?.groupMetadata?.subject || undefined;
          } catch {
            /* sin chat por id */
          }
        }
        if (!nombreWa) {
          try {
            const gc: any = await this.client.getContactById(message.from);
            nombreWa = gc?.name || gc?.pushname || undefined;
          } catch {
            /* sin nombre de grupo */
          }
        }

        if (authorJid) {
          try {
            const ac: any = await this.client.getContactById(authorJid);
            authorName =
              ac?.pushname || ac?.name || (ac?.number ? `+${ac.number}` : null);
          } catch {
            /* sin contacto del autor */
          }
        }
        if (!authorName) {
          try {
            const c: any = await message.getContact();
            authorName = c?.pushname || c?.name || null;
          } catch {
            /* sin autor */
          }
        }
      } else {
        // Individual: resolver el número REAL (LID → teléfono) y armar el jid
        // canónico `{numero}@c.us` para matchear con el cliente sin duplicar.
        telefono = (message.from.split('@')[0] || '').replace(/\D/g, '');
        nombreWa = (message as any)?._data?.notifyName || undefined;
        try {
          const contact: any = await message.getContact();
          const realNumber = (contact?.number || '')
            .toString()
            .replace(/\D/g, '');
          if (realNumber) {
            telefono = realNumber;
            jid = `${realNumber}@c.us`;
          }
          nombreWa = contact?.pushname || contact?.name || nombreWa;
        } catch (e) {
          console.warn(
            '⚠️ No se pudo resolver el contacto (LID→teléfono):',
            (e as any)?.message || e,
          );
        }
      }

      return {
        jid,
        // LID de WhatsApp: si el remitente vino como `...@lid`, se manda aparte
        // para que Laravel pueda unificar el hilo aunque la resolución
        // LID→número falle en algún mensaje (evita contactos duplicados).
        lid: message.from.endsWith('@lid') ? message.from : null,
        telefono,
        nombre_wa: nombreWa,
        wa_uid: waUid,
        direction: 'in',
        tipo,
        texto: message.body || null,
        is_group: isGroup,
        author_jid: authorJid,
        author_name: authorName,
        wa_timestamp: message.timestamp, // unix segundos
        media,
      };
    };

    await this.postLaravelConReintentos(
      '/api/whatsapp/inbound',
      buildPayload,
      `mensaje entrante (${waUid || message.from})`,
      20000,
    );
  }

  /**
   * Reenvía a Laravel el ack (estado de entrega/lectura) de un mensaje saliente
   * para que el estudio vea ✓ / ✓✓ / ✓✓ azul. Sólo aplica a mensajes propios.
   */
  private async forwardAckToLaravel(
    message: Message,
    ack: number,
  ): Promise<void> {
    if (!message?.fromMe) {
      return; // sólo nos importan los acks de lo que enviamos nosotros
    }
    const laravelUrl = (process.env.LARAVEL_URL || '').replace(/\/+$/, '');
    if (!laravelUrl) {
      return;
    }
    const waUid = message.id?._serialized;
    if (!waUid) {
      return;
    }

    await this.postLaravelConReintentos(
      '/api/whatsapp/ack',
      () => ({ wa_uid: waUid, ack }),
      `ack ${ack} (${waUid})`,
      10000,
    );
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

  /**
   * Envío saliente desde el estudio contable (Laravel) hacia CUALQUIER cliente.
   * A diferencia de sendImage(), NO aplica isAuthorizedChatId: el estudio puede
   * responder a cualquier número. Soporta texto y/o adjuntos (base64).
   * Devuelve los id serializados de los mensajes enviados.
   */
  async sendOutbound(params: {
    to: string;
    text?: string;
    media?: Array<{ mime: string; filename?: string; base64: string }>;
  }): Promise<{ ok: boolean; ids: string[]; status: string }> {
    if (!this.isConnectionReady()) {
      throw new Error('WhatsApp no conectado');
    }

    const chatId = this.normalizeChatId(params.to);
    const text = (params.text || '').trim();
    const media = Array.isArray(params.media) ? params.media : [];
    const ids: string[] = [];

    if (media.length > 0) {
      for (let i = 0; i < media.length; i++) {
        const m = media[i];
        if (!m || !m.base64) continue;
        const data = m.base64.includes(',')
          ? m.base64.split(',')[1]
          : m.base64;
        const mm = new MessageMedia(
          m.mime || 'application/octet-stream',
          data,
          m.filename || undefined,
        );
        // El caption (texto) va sólo en el primer adjunto.
        const sent = await this.client.sendMessage(chatId, mm, {
          caption: i === 0 ? text : '',
          sendSeen: false,
        });
        if (sent?.id?._serialized) ids.push(sent.id._serialized);
      }
    } else {
      if (!text) {
        throw new Error('Mensaje vacío');
      }
      const sent = await this.client.sendMessage(chatId, text, {
        sendSeen: false,
      });
      if (sent?.id?._serialized) ids.push(sent.id._serialized);
    }

    console.log(`✅ Mensaje saliente enviado a ${chatId} (${ids.length} parte/s)`);
    return { ok: true, ids, status: 'sent' };
  }

  private normalizeChatId(to: string): string {
    if (!to) throw new Error('Destinatario vacío');
    if (to.includes('@')) return to;
    const digits = to.replace(/\D/g, '');
    if (!digits) throw new Error('Destinatario inválido');
    return `${digits}@c.us`;
  }

  /**
   * Resuelve un número telefónico al chatId canónico de WhatsApp usando la API
   * de WhatsApp (getNumberId). Sirve para iniciar conversaciones desde el
   * estudio (Laravel) hacia un cliente que todavía no escribió, evitando
   * contactos duplicados cuando el cliente responda.
   *
   * ⚠️ En WhatsApp nuevo, getNumberId puede devolver un LID (`...@lid`) en vez
   * del `@c.us`. Para que el contacto sea EL MISMO que cuando el cliente escribe
   * (que entra como `{numero}@c.us`), resolvemos el número real del contacto y
   * devolvemos siempre un jid `{numero}@c.us`. El LID queda sólo como último
   * recurso si no se pudo obtener el número.
   *
   * Devuelve exists=false si el número no está registrado en WhatsApp.
   */
  async resolveNumber(
    number: string,
  ): Promise<{
    ok: boolean;
    exists: boolean;
    jid: string | null;
    number: string | null;
  }> {
    if (!this.isConnectionReady()) {
      throw new Error('WhatsApp no conectado');
    }
    const digits = (number || '').replace(/\D/g, '');
    if (!digits) {
      throw new Error('Número vacío');
    }
    const id: any = await this.client.getNumberId(digits);
    if (!id?._serialized) {
      return { ok: true, exists: false, jid: null, number: null };
    }

    // Obtener el número real (convierte LID → teléfono) vía el contacto.
    let realNumber = '';
    try {
      const contact: any = await this.client.getContactById(id._serialized);
      realNumber = (contact?.number || '').toString().replace(/\D/g, '');
    } catch (e) {
      console.warn(
        '⚠️ No se pudo resolver el contacto al iniciar chat:',
        (e as any)?.message || e,
      );
    }
    // Si el id NO es un LID y trae el número en `user`, usarlo como respaldo.
    if (!realNumber && id.user && !String(id._serialized).includes('@lid')) {
      realNumber = String(id.user).replace(/\D/g, '');
    }

    const jid = realNumber ? `${realNumber}@c.us` : id._serialized;
    return { ok: true, exists: true, jid, number: realNumber || null };
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

  // ── Monitor de salud + alerta por email ────────────────────────────────────
  // Cada N minutos (HEALTH_CHECK_INTERVAL_MIN, default 30) verifica que el bot
  // esté realmente operativo (conectado + estable + heartbeat vivo = puede
  // enviar/recibir). Si NO lo está, manda un email de alerta. No spamea: avisa
  // al caer, re-avisa cada HEALTH_REALERT_HOURS (default 3) mientras siga caído,
  // y manda un email de "recuperado" cuando vuelve.
  //
  // Config por env:
  //   ALERT_EMAIL_TO            destino(s), separados por coma. SIN esto, el monitor NO corre.
  //   HEALTH_CHECK_INTERVAL_MIN intervalo de chequeo (default 30)
  //   HEALTH_REALERT_HOURS      cada cuántas horas re-avisar si sigue caído (default 3)
  //   SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS / SMTP_FROM
  private startHealthMonitor() {
    const to = (process.env.ALERT_EMAIL_TO || '').trim();
    if (!to) {
      console.log(
        'ℹ️ Monitor de salud deshabilitado (falta ALERT_EMAIL_TO en el .env).',
      );
      return;
    }
    const intervalMin = Number(process.env.HEALTH_CHECK_INTERVAL_MIN) || 30;
    const intervalMs = Math.max(1, intervalMin) * 60 * 1000;
    console.log(
      `🩺 Monitor de salud activo: chequeo cada ${intervalMin} min, alertas a ${to}`,
    );

    // Primer chequeo a los 5 min: detecta fallos de arranque sin esperar todo el intervalo.
    this.healthFirstCheckTimer = setTimeout(
      () => this.performHealthCheck().catch(() => {}),
      5 * 60 * 1000,
    );
    this.healthCheckTimer = setInterval(
      () => this.performHealthCheck().catch(() => {}),
      intervalMs,
    );
  }

  private stopHealthMonitor() {
    if (this.healthFirstCheckTimer) {
      clearTimeout(this.healthFirstCheckTimer);
      this.healthFirstCheckTimer = null;
    }
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /** ¿El bot puede enviar/recibir ahora mismo? (conectado + estable + heartbeat vivo) */
  private async isBotHealthy(): Promise<boolean> {
    try {
      if (!this.client || !this.isConnected) return false;
      if (!this.isConnectionReady()) return false;
      const state = await this.client.getState();
      if (state !== 'CONNECTED') return false;
      // El heartbeat corre cada 30s; si hace >3 min que no late, está colgado.
      if (this.lastHeartbeat && Date.now() - this.lastHeartbeat > 3 * 60 * 1000) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private async performHealthCheck(): Promise<void> {
    const to = (process.env.ALERT_EMAIL_TO || '').trim();
    if (!to) return;

    const healthy = await this.isBotHealthy();
    const now = Date.now();

    if (healthy) {
      if (this.healthLastStatus === 'down') {
        const downMin = Math.round((now - this.healthDownSince) / 60000);
        await this.sendAlertEmail(
          '✅ Bot de WhatsApp RECUPERADO',
          `El bot volvió a estar operativo (puede enviar/recibir).\n` +
            `Estuvo caído ~${downMin} min.\n` +
            `Fecha: ${new Date().toLocaleString('es-AR')}`,
        );
      } else {
        console.log('🩺 Chequeo de salud: OK (conectado y operativo).');
      }
      this.healthLastStatus = 'ok';
      this.healthDownSince = 0;
      return;
    }

    // No saludable
    const reAlertMs =
      (Number(process.env.HEALTH_REALERT_HOURS) || 3) * 60 * 60 * 1000;
    const recienCaido = this.healthLastStatus !== 'down';
    if (recienCaido) {
      this.healthDownSince = now;
    }

    if (recienCaido || now - this.healthLastAlertAt >= reAlertMs) {
      let estado = 'desconocido';
      try {
        estado = this.client ? await this.client.getState() : 'sin cliente';
      } catch {
        estado = 'sin respuesta';
      }
      const downMin = Math.round((now - this.healthDownSince) / 60000);
      await this.sendAlertEmail(
        '❌ Bot de WhatsApp CAÍDO',
        `El bot NO está operativo: no puede enviar/recibir mensajes.\n\n` +
          `Estado WhatsApp: ${estado}\n` +
          `Reconectando: ${this.isReconnecting ? 'sí' : 'no'}\n` +
          `Intentos de reconexión: ${this.reconnectAttempts}\n` +
          `Caído desde hace: ~${downMin} min\n` +
          `Fecha: ${new Date().toLocaleString('es-AR')}\n\n` +
          `El bot sigue reintentando reconectar solo. Si no se recupera, ` +
          `revisá Railway (red/IP) o re-escaneá el QR.`,
      );
      this.healthLastAlertAt = now;
    }
    this.healthLastStatus = 'down';
  }

  private async sendAlertEmail(subject: string, text: string): Promise<void> {
    const to = (process.env.ALERT_EMAIL_TO || '').trim();
    const host = (process.env.SMTP_HOST || '').trim();
    if (!to || !host) {
      console.warn(
        `⚠️ Alerta NO enviada (falta SMTP_HOST o ALERT_EMAIL_TO): ${subject}`,
      );
      return;
    }
    try {
      const transporter = nodemailer.createTransport({
        host,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: (process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
        auth: process.env.SMTP_USER
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
      });
      await transporter.sendMail({
        from:
          process.env.SMTP_FROM ||
          process.env.SMTP_USER ||
          'haddybot@localhost',
        to,
        subject: `[HaddyBot WhatsApp] ${subject}`,
        text,
      });
      console.log(`📧 Alerta enviada: "${subject}" → ${to}`);
    } catch (e) {
      console.error(
        '❌ No se pudo enviar la alerta por email:',
        (e as any)?.message || e,
      );
    }
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
    this.stopHealthMonitor();
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
