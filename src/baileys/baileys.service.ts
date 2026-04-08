import { Injectable, OnModuleInit } from '@nestjs/common';
import { Boom } from '@hapi/boom';
import * as qrcode from 'qrcode-terminal';
import { BotSynergysService } from 'src/botsynergys/botsynergys.service';
import { QuestionsService } from '../questions/questions.service';
import { MessageVDto } from '../venom/messagev.dto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, parse } from 'path';
import { ImageAnalysisService } from 'src/image-analysis/image-analysis.service';
import { GptVisionService } from 'src/gpt-vision/gpt-vision.service';
import { ChatGptTextService } from 'src/chatgpt-text/chatgpt-text.service';
import { GoogleDriveService } from 'src/google-drive/google-drive.service';
import { DropboxService } from 'src/dropbox/dropbox.service';
import { remove as removeAccents } from 'diacritics';

// Declaraciones de tipos para Baileys
type WASocket = any;
type WAMessage = any;
type DisconnectReason = any;

interface QueuedMessage {
  messageDto: MessageVDto;
  timestamp: number;
  attempts: number;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

@Injectable()
export class BaileysService implements OnModuleInit {
  private socket: WASocket;
  private isConnected = false;
  private connectionState: string = 'close';
  private baileys: any;
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
      console.log('🚀 Inicializando cliente de Baileys...');
      // Importar Baileys dinámicamente usando eval para evitar problemas de compilación
      this.baileys = await eval('import("@whiskeysockets/baileys")');
      await this.initializeBaileys();
    } catch (error) {
      console.error('❌ Error inicializando Baileys:', error);
      throw error;
    }
  }

  private async initializeBaileys() {
    try {
      const authDir = './baileys_auth';
      if (!existsSync(authDir)) {
        mkdirSync(authDir, { recursive: true });
      }

      const { state, saveCreds } =
        await this.baileys.useMultiFileAuthState(authDir);

      // Crear un logger personalizado que implementa todos los métodos necesarios
      const customLogger = {
        level: 'silent',
        child: () => customLogger,
        trace: () => {},
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        fatal: () => {},
      };

      this.socket = this.baileys.default({
        auth: state,
        logger: customLogger as any,
        qrTimeout: 120000, // 2 minutos para el QR (más tiempo)
        connectTimeoutMs: 30000, // 30 segundos timeout de conexión (más rápido)
        defaultQueryTimeoutMs: 30000, // 30 segundos timeout de query (más rápido)
        keepAliveIntervalMs: 25000, // Keep alive cada 25 segundos (más frecuente)
        generateHighQualityLinkPreview: true,
        retryRequestDelayMs: 1000, // 1 segundo entre reintentos (más tiempo)
        maxMsgRetryCount: 3, // Menos reintentos para evitar spam
        markOnlineOnConnect: false, // No marcar online automáticamente
        browser: ['WhatsApp Bot', 'Chrome', '4.0.0'], // Browser más estable
        syncFullHistory: false, // No sincronizar historial completo
        shouldSyncHistoryMessage: () => false, // No sincronizar mensajes históricos
        getMessage: async () => undefined, // No obtener mensajes perdidos
        emitOwnEvents: false, // No emitir eventos propios
        fireInitQueries: true, // Ejecutar queries iniciales
        shouldIgnoreJid: () => false, // No ignorar JIDs
        linkPreviewImageThumbnailWidth: 192, // Thumbnail más pequeño
        transactionOpts: {
          maxCommitRetries: 5,
          delayBetweenTriesMs: 3000,
        },
        options: {
          keepAliveIntervalMs: 25000,
        },
      });

      // Manejar eventos de conexión
      this.socket.ev.on('connection.update', (update) => {
        this.handleConnectionUpdate(update);
      });

      // Guardar credenciales cuando se actualicen
      this.socket.ev.on('creds.update', saveCreds);
    } catch (error) {
      console.error('❌ Error en initializeBaileys:', error);
      this.scheduleReconnect(5000);
    }
  }

  private handleConnectionUpdate(update: any) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📱 Código QR generado:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      this.isConnected = false;
      this.connectionState = 'close';

      const shouldReconnect =
        (lastDisconnect?.error as Boom)?.output?.statusCode !==
        this.baileys.DisconnectReason.loggedOut;
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

      console.log(
        '🔌 Conexión cerrada debido a:',
        lastDisconnect?.error?.message || 'Error desconocido',
      );
      console.log('📊 Código de estado:', statusCode);
      console.log('🔄 ¿Debe reconectar?:', shouldReconnect);

      if (
        shouldReconnect &&
        this.reconnectAttempts < this.maxReconnectAttempts
      ) {
        this.handleReconnection(statusCode);
      } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        console.log('❌ Máximo número de intentos de reconexión alcanzado');
        this.clearMessageQueue(
          'Máximo número de intentos de reconexión alcanzado',
        );
      } else {
        console.log('❌ No se reconectará - usuario deslogueado');
        this.clearMessageQueue('Usuario deslogueado');
      }
    } else if (connection === 'open') {
      console.log('✅ Conectado exitosamente a WhatsApp!');
      this.isConnected = true;
      this.connectionState = 'open';
      this.lastConnectionTime = Date.now();
      this.reconnectAttempts = 0;
      this.isReconnecting = false;

      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }

      this.setupMessageListener();
      this.processMessageQueue();
      this.startHeartbeat(); // Iniciar heartbeat cuando se conecte
    } else if (connection === 'connecting') {
      console.log('🔄 Conectando a WhatsApp...');
      this.connectionState = 'connecting';
    }
  }

  private handleReconnection(statusCode: number) {
    if (this.isReconnecting) {
      console.log('⏳ Ya hay una reconexión en progreso...');
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;

    const reconnectDelay = this.calculateReconnectDelay(statusCode);

    console.log(
      `⏳ Intento de reconexión ${this.reconnectAttempts}/${this.maxReconnectAttempts} en ${reconnectDelay / 1000} segundos...`,
    );

    this.scheduleReconnect(reconnectDelay);
  }

  private calculateReconnectDelay(statusCode: number): number {
    const baseDelay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts - 1),
      30000,
    ); // Exponential backoff con máximo de 30s

    switch (statusCode) {
      case 408: // Request Timeout (QR expirado) - Más agresivo para errores 408
        console.log('⚠️ Error 408 detectado, reconectando rápidamente...');
        return Math.max(baseDelay, 5000); // Reducido de 15000 a 5000 (5 segundos)
      case 428: // Precondition Required (Connection Terminated)
        console.log(
          '⚠️ Conexión terminada por WhatsApp, esperando antes de reconectar',
        );
        return Math.max(baseDelay, 20000);
      case 401: // Unauthorized
        console.log('⚠️ Error de autorización, esperando antes de reconectar');
        return Math.max(baseDelay, 25000);
      case 403: // Forbidden
        console.log('⚠️ Acceso prohibido, esperando más tiempo');
        return Math.max(baseDelay, 35000);
      case 500: // Internal Server Error
        console.log('⚠️ Error del servidor de WhatsApp');
        return Math.max(baseDelay, 10000);
      case 503: // Service Unavailable
        console.log('⚠️ Servicio no disponible');
        return Math.max(baseDelay, 15000);
      default:
        console.log('⚠️ Error de conexión genérico');
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
        await this.initializeBaileys();
      } catch (error) {
        console.error('❌ Error durante la reconexión:', error);
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.scheduleReconnect(5000);
        }
      }
    }, delay);
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

        // Pequeña pausa entre mensajes para evitar spam
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

  private setupMessageListener() {
    console.log('👂 Configurando listener de mensajes...');

    this.socket.ev.on('messages.upsert', async (m) => {
      const message = m.messages[0];

      if (!message.message || message.key.fromMe) {
        return;
      }

      try {
        console.log('📨 Mensaje recibido de:', message.key.remoteJid);

        const messageContent = this.extractMessageContent(message);
        if (!messageContent || message.key.remoteJid === 'status@broadcast') {
          console.log('⏭️ Mensaje ignorado (sin contenido válido o de estado)');
          return;
        }

        console.log('✅ Procesando mensaje:', {
          from: message.key.remoteJid,
          isGroup: message.key.remoteJid?.includes('@g.us'),
          content: messageContent.substring(0, 50) + '...',
        });

        if (message.key.remoteJid?.includes('@g.us')) {
          await this.handleGroupMessage(message, messageContent);
        } else {
          await this.handleIndividualMessage(message, messageContent);
        }
      } catch (error) {
        console.error('❌ Error procesando mensaje:', error);
      }
    });

    console.log('✅ Listener de mensajes configurado correctamente');
  }

  private extractMessageContent(message: WAMessage): string | null {
    if (!message.message) return null;

    const messageType = this.baileys.getContentType(message.message);

    if (messageType === 'conversation') {
      return message.message?.conversation || null;
    } else if (messageType === 'extendedTextMessage') {
      return message.message?.extendedTextMessage?.text || null;
    } else if (messageType === 'imageMessage') {
      return message.message?.imageMessage?.caption || 'Imagen';
    } else if (messageType === 'videoMessage') {
      return message.message?.videoMessage?.caption || 'Video';
    } else if (messageType === 'documentMessage') {
      return message.message?.documentMessage?.caption || 'Documento';
    }

    return null;
  }

  private async handleGroupMessage(message: WAMessage, messageContent: string) {
    const targetMention = '32397642989644@s.whatsapp.net';

    // Array de grupos permitidos - agrega aquí los IDs de grupos adicionales
    const allowedGroups = [
      '120363422110552517@g.us', // Grupo original
      '120363418511991684@g.us', // Descomenta y agrega el nuevo ID aquí
    ];

    const isCorrectGroup = allowedGroups.includes(message.key.remoteJid);

    // Verificar menciones en Baileys
    const mentions =
      message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const isMentioned = mentions.some((jid) => jid.includes('32397642989644'));

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
      const respuestaCodigo = `🆔 ID del grupo: ${message.key.remoteJid}`;
      const savedCodigo = await this.saveMessage(message, messageContent);
      await this.sendMessage({
        messageTo: message.key.remoteJid!,
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
      messageTo: message.key.remoteJid!,
      questionText: respuesta,
    });

    await this.questionsService.updateResponse(saved.id, respuesta);
  }

  private intentosFallidos: Record<string, number> = {};

  private async handleIndividualMessage(
    message: WAMessage,
    messageContent: string,
  ) {
    const sender = message.key.remoteJid!;

    try {
      // Lógica similar al servicio Venom pero adaptada para Baileys
      const saved = await this.saveMessage(message, messageContent);

      // Verificar si es una imagen
      if (message.message) {
        const messageType = this.baileys.getContentType(message.message);
        if (messageType === 'imageMessage') {
          await this.handleImageMessage(message, sender, saved.id);
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

  private async handleImageMessage(
    message: WAMessage,
    sender: string,
    savedMessageId: number,
  ) {
    try {
      console.log('🖼️ Procesando imagen...');

      // Descargar la imagen
      const buffer = await this.baileys.downloadMediaMessage(
        message,
        'buffer',
        {},
      );

      if (!buffer) {
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
      const safeTextoImagen = message.message?.imageMessage?.caption ?? '';
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

      const fecha = new Date().toISOString().split('T')[0];
      const ambulancia = `${vehiculo}`;
      const nombreArchivo = `foto_${this.sanitizeFileName(nombre)}_${Date.now()}.jpg`;
      const ruta = join('./uploads', fecha);

      if (!existsSync(ruta)) mkdirSync(ruta, { recursive: true });
      const fullPath = join(ruta, nombreArchivo);
      writeFileSync(fullPath, buffer);
      console.log(`📷 Imagen guardada: ${fullPath}`);

      //const analysis = await this.imageAnalysisService.analyzeImage(fullPath); para no analizar con el image-analysis.service
      //enviando todo a chat-gpt-vision.service
      let analysis: {
        faceDetected: boolean;
        date: string | null;
        lat: number | null;
        lng: number | null;
      };

      analysis = {
        faceDetected: false,
        date: null,
        lat: null,
        lng: null,
      };
      //enviando todo a chat-gpt-vision.service

      console.log('🕓 Fecha de la foto:', analysis.date);
      console.log('📍 Coordenadas:', analysis.lat, analysis.lng);
      console.log('🧠 ¿Hay rostro humano?:', analysis.faceDetected);

      const safeDate = analysis.date ?? '';
      const safeLat = analysis.lat ?? '';
      const safeLng = analysis.lng ?? '';
      const safeFaceDetected = analysis.faceDetected ?? '';

      const userKey = sender;
      const datosIncompletos = !analysis.date || !analysis.lat || !analysis.lng;

      if (datosIncompletos) {
        this.intentosFallidos[userKey] =
          (this.intentosFallidos[userKey] || 0) + 1;

        if (this.intentosFallidos[userKey] >= 1) {
          /*  await this.sendMessage({
            messageTo: sender,
            questionText: '⚠️ Parece que la imagen no se ve del todo clara.'
          }); */

          /* await this.sendMessage({
            messageTo: sender,
            questionText: 'Dame solo un momento más, la estoy revisando para darte la respuesta... ⌛'
          }); */

          // Escalar a GPT Vision
          console.warn('🔎 Imagen enviada a revisión:', fullPath);
          const gptVisionResponse = await this.gptVisionService.revisarImagen(
            fullPath,
            sender,
          );
          console.log('🚀 Respuesta de GPT Vision:', gptVisionResponse);

          //const { date, lat, lng } = gptVisionResponse;
          const { date } = gptVisionResponse;
          const lat = parseFloat(gptVisionResponse.lat || '-37.3870416');
          const lng = parseFloat(gptVisionResponse.lng || '-59.1299733');

          if (date && lat && lng) {
            this.intentosFallidos[userKey] = 0;
            const numeroWhatsapp = sender.split('@')[0];
            const faceDetected = gptVisionResponse.faceDetected;

            // Enviar foto a Dropbox
            console.log('✅ Enviando imagen a Dropbox');
            console.log('✅ fullPath:', fullPath);
            console.log('✅ nombreArchivo:', nombreArchivo);
            console.log('✅ vehiculo:', vehiculo);
            const link = await this.dropboxService.uploadFile(
              fullPath,
              nombreArchivo,
              vehiculo || 'no identificado',
            );
            console.log('✅ Imagen enviada a Dropbox link:', link);

            const mensajeConfirmacion = `✅ ¡Asistencia registrada con éxito!\n🗓 Fecha: ${date}\n📍 Base Operativa - Kacike\n🧑‍🦱 Rostro detectado: ${faceDetected ? 'Sí' : 'No'}\n👤 Nombre: ${nombre || 'No identificado'}\n🚑 Lugar de Trabajo: ${vehiculo || 'No identificado'}\n📌 Gracias por confirmar tu asistencia.`;

            await this.sendMessage({
              messageTo: sender,
              questionText: mensajeConfirmacion,
            });

            console.log('✅ Msj confirmacion 2 enviado a', sender);

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

          // Reiniciar contador después de escalar
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

      const mensajeConfirmacion = `✅ ¡Asistencia registrada con éxito!\n🗓 Fecha: ${safeDate}\n📍 Base Operativa - Kacike\n🧑‍🦱 Rostro detectado: ${safeFaceDetected ? 'Sí' : 'No'}\n👤 Nombre: ${nombre || 'No identificado'}\n🚑 Lugar de Trabajo: ${vehiculo || 'No identificado'}\n📌 Gracias por confirmar tu asistencia.`;

      await this.sendMessage({
        messageTo: sender,
        questionText: mensajeConfirmacion,
      });

      console.log('✅ Mensaje de confirmación 1 enviado a', sender);

      // Si todo salió bien, reiniciar contador
      this.intentosFallidos[userKey] = 0;
      const numeroWhatsapp = sender.split('@')[0];

      // Enviar foto a Dropbox
      console.log('✅ Enviando imagen a Dropbox');
      console.log('✅ fullPath:', fullPath);
      console.log('✅ nombreArchivo:', nombreArchivo);
      console.log('✅ vehiculo:', vehiculo);
      const link = await this.dropboxService.uploadFile(
        fullPath,
        nombreArchivo,
        vehiculo || 'no identificado',
      );
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
        safeTextoImagen,
      );

      await this.questionsService.updateResponse(savedMessageId, respuesta);
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

  private async saveMessage(message: WAMessage, content: string) {
    const messageData = {
      questionText: content,
      messageFrom: message.key.remoteJid!,
      messageTo: '',
      isGroupMsg: message.key.remoteJid?.includes('@g.us') || false,
      platform: 'baileys',
    };

    return await this.questionsService.saveWithoutResponse(messageData);
  }

  async sendMessage(messageDto: MessageVDto): Promise<string> {
    try {
      // Validar estado de conexión más robustamente
      if (!this.isConnectionReady()) {
        console.log(
          '⚠️ Conexión no disponible, agregando mensaje a la cola...',
        );
        return await this.queueMessage(messageDto);
      }

      return await this.sendMessageDirect(messageDto);
    } catch (error) {
      console.error('❌ Error enviando mensaje:', error);

      // Si el error es de conexión, agregar a la cola
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
      if (!this.socket || !this.isConnected) {
        throw new Error('Cliente no conectado');
      }

      await this.socket.sendMessage(messageDto.messageTo, {
        text: messageDto.questionText,
      });
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

  private isConnectionReady(): boolean {
    const isBasicConnectionOk =
      this.isConnected && this.socket && this.connectionState === 'open';

    if (!isBasicConnectionOk) {
      return false;
    }

    // Verificar si la conexión es estable (ha estado conectada por al menos 30 segundos)
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
      'socket closed',
      'not connected',
      'disconnected',
      'timeout',
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

      // Si no estamos reconectando, intentar reconectar
      if (!this.isReconnecting && !this.isConnected) {
        console.log('🔄 Iniciando reconexión debido a mensaje en cola...');
        this.handleReconnection(0); // Usar código 0 para reconexión inmediata
      }
    });
  }

  private async waitForConnection(): Promise<void> {
    const maxAttempts = 60; // Aumentado a 60 intentos (2 minutos)
    let attempts = 0;

    console.log('⏳ Esperando conexión completa...');

    while (!this.isConnectionReady() && attempts < maxAttempts) {
      attempts++;
      console.log(
        `🔄 Intento ${attempts}/${maxAttempts} - Estado: ${this.connectionState} - Conectado: ${this.isConnected}`,
      );

      if (this.isConnectionReady()) {
        console.log('✅ Conexión establecida y estable');
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    if (!this.isConnectionReady()) {
      throw new Error('Timeout esperando conexión estable');
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      if (!this.socket || !this.isConnected) {
        console.log(
          '❌ Test de conexión falló: socket o conexión no disponible',
        );
        return false;
      }

      // Intentar obtener información del usuario
      const user = this.socket.user;
      console.log('👤 Usuario conectado:', user?.id);

      // Verificar si podemos enviar un mensaje de prueba (sin enviarlo realmente)
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

    return {
      isConnected: this.isConnected,
      connectionState: this.connectionState,
      isReconnecting: this.isReconnecting,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
      connectionAge: connectionAge,
      isStable: isStable,
      queuedMessages: this.messageQueue.length,
      user: this.socket?.user || null,
      timestamp: new Date().toISOString(),
    };
  }

  // Método para limpiar la cola manualmente
  async clearQueue(): Promise<void> {
    this.clearMessageQueue('Limpieza manual de la cola');
  }

  // Método para forzar reconexión
  async forceReconnect(): Promise<void> {
    console.log('🔄 Forzando reconexión...');

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.isConnected = false;
    this.connectionState = 'close';
    this.isReconnecting = false;
    this.reconnectAttempts = 0;

    await this.initializeBaileys();
  }

  // Método para cerrar la conexión limpiamente
  async disconnect() {
    console.log('🔌 Iniciando desconexión...');

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.stopHeartbeat(); // Detener heartbeat al desconectar
    this.clearMessageQueue('Desconexión solicitada');

    if (this.socket) {
      try {
        await this.socket.logout();
      } catch (error) {
        console.error('❌ Error durante logout:', error);
      }

      this.isConnected = false;
      this.connectionState = 'close';
      this.socket = null;
      console.log('🔌 Desconectado de WhatsApp');
    }
  }

  // Sistema de Heartbeat para mantener la conexión activa
  private startHeartbeat() {
    console.log('💓 Iniciando sistema de heartbeat...');

    this.stopHeartbeat(); // Limpiar cualquier heartbeat anterior
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
      if (!this.socket || !this.isConnected) {
        console.log('💔 Heartbeat falló: no hay conexión');
        this.handleHeartbeatFailure();
        return;
      }

      // Intentar obtener el estado del usuario como ping
      const user = this.socket.user;
      if (!user) {
        console.log(
          '💔 Heartbeat falló: no se pudo obtener información del usuario',
        );
        this.handleHeartbeatFailure();
        return;
      }

      // Verificar si la conexión sigue siendo estable
      if (!this.isConnectionReady()) {
        console.log('💔 Heartbeat falló: conexión no estable');
        this.handleHeartbeatFailure();
        return;
      }

      // Heartbeat exitoso
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

      // Marcar como desconectado y forzar reconexión
      this.isConnected = false;
      this.connectionState = 'close';

      if (!this.isReconnecting) {
        this.handleReconnection(408); // Usar código 408 para timeout
      }
    }
  }
}
