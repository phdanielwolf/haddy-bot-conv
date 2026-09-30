import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  Query,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  HttpException,
} from '@nestjs/common';
import { WwebjsService } from './wwebjs.service';
import { MessageVDto } from '../venom/messagev.dto';
import { SendImageDto } from './send-image.dto';

@Controller('baileys')
export class WwebjsController {
  constructor(private readonly wwebjsService: WwebjsService) {}

  // 📨 Enviar mensaje a través de WhatsApp Web.js
  @Post('sendmessage')
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() createDto: MessageVDto): Promise<string> {
    return this.wwebjsService.sendMessage(createDto);
  }

  @Get('sendmessage')
  async findAll(): Promise<string> {
    return 'WhatsApp Web.js API funcionando';
  }

  @Get('status')
  async getStatus(): Promise<any> {
    return this.wwebjsService.getConnectionStatus();
  }

  @Get('test-connection')
  async testConnection(): Promise<{
    connected: boolean;
    message: string;
    details?: any;
  }> {
    const isConnected = await this.wwebjsService.testConnection();
    const status = await this.wwebjsService.getConnectionStatus();

    return {
      connected: isConnected,
      message: isConnected
        ? 'Conexión exitosa con WhatsApp Web.js'
        : 'Sin conexión a WhatsApp',
      details: status,
    };
  }

  // 🖼️ Enviar imagen (base64 data URL)
  @Post('sendimage')
  @HttpCode(HttpStatus.CREATED)
  async sendImage(@Body() dto: SendImageDto): Promise<string> {
    return this.wwebjsService.sendImage(dto);
  }

  // 📤 Envío saliente desde el estudio (Laravel) hacia un cliente.
  // Body: { to, text?, media?: [{ mime, filename, base64 }] }
  // Auth opcional: header X-API-KEY = WA_INBOUND_API_KEY (o CV_IMPORT_API_KEY).
  @Post('send')
  @HttpCode(HttpStatus.CREATED)
  async send(
    @Body()
    body: {
      to: string;
      text?: string;
      media?: Array<{ mime: string; filename?: string; base64: string }>;
    },
    @Headers('x-api-key') apiKey?: string,
  ): Promise<{ ok: boolean; ids: string[]; status: string }> {
    const expected =
      process.env.WA_INBOUND_API_KEY || process.env.CV_IMPORT_API_KEY || '';
    if (expected && apiKey !== expected) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }
    try {
      return await this.wwebjsService.sendOutbound(body);
    } catch (e) {
      throw new HttpException(
        (e as any)?.message || 'No se pudo enviar el mensaje',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  // 🔎 Resolver un número al chatId canónico de WhatsApp (para iniciar chats).
  // Body: { number }  → { ok, exists, jid: {numero}@c.us, number }
  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  async resolve(
    @Body() body: { number: string },
    @Headers('x-api-key') apiKey?: string,
  ): Promise<{
    ok: boolean;
    exists: boolean;
    jid: string | null;
    number: string | null;
  }> {
    const expected =
      process.env.WA_INBOUND_API_KEY || process.env.CV_IMPORT_API_KEY || '';
    if (expected && apiKey !== expected) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }
    try {
      return await this.wwebjsService.resolveNumber(body?.number);
    } catch (e) {
      throw new HttpException(
        (e as any)?.message || 'No se pudo resolver el número',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('disconnect')
  async disconnect(): Promise<{ message: string }> {
    await this.wwebjsService.disconnect();
    return {
      message: 'Desconectado exitosamente de WhatsApp Web.js',
    };
  }

  @Post('force-reconnect')
  async forceReconnect(): Promise<{ message: string }> {
    await this.wwebjsService.forceReconnect();
    return {
      message: 'Reconexión forzada iniciada',
    };
  }

  @Post('clear-queue')
  async clearQueue(): Promise<{ message: string }> {
    await this.wwebjsService.clearQueue();
    return {
      message: 'Cola de mensajes limpiada',
    };
  }
}

@Controller('whatsapp')
export class WhatsappQrController {
  constructor(private readonly wwebjsService: WwebjsService) {}

  @Get('qr')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  getQr() {
    return this.wwebjsService.getQr();
  }

  // 🔍 Qué mostraba el Chrome del bot la última vez que falló la conexión
  // (captura + URL + texto). Protegido con la misma API key que /baileys/send:
  // /whatsapp/debug-view?key=XXX
  @Get('debug-view')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  debugView(
    @Query('key') key?: string,
    @Headers('x-api-key') apiKey?: string,
  ): string {
    const expected =
      process.env.WA_INBOUND_API_KEY || process.env.CV_IMPORT_API_KEY || '';
    if (expected && key !== expected && apiKey !== expected) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }
    const e = this.wwebjsService.getLastInitError();
    const esc = (v: string | null | undefined) =>
      String(v ?? '').replace(
        /[&<>"]/g,
        (c) =>
          ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] || c,
      );
    const cuerpo = !e
      ? '<p>No hubo fallos de conexión desde el último arranque.</p>'
      : `<table cellpadding="4">
          <tr><td><b>Fecha</b></td><td>${esc(e.at)}</td></tr>
          <tr><td><b>Error</b></td><td>${esc(e.message)}</td></tr>
          <tr><td><b>URL</b></td><td>${esc(e.url)}</td></tr>
          <tr><td><b>Título</b></td><td>${esc(e.title)}</td></tr>
          ${e.captureError ? `<tr><td><b>Captura</b></td><td>${esc(e.captureError)}</td></tr>` : ''}
        </table>
        <h3>Texto de la página</h3>
        <pre style="white-space:pre-wrap;background:#f4f4f4;padding:8px">${esc(e.text)}</pre>
        ${e.screenshot ? `<h3>Captura</h3><img src="${e.screenshot}" style="max-width:100%;border:1px solid #ccc" />` : ''}`;
    return `<!doctype html><html lang="es"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>WhatsApp bot - diagnóstico</title></head>
<body style="font-family: system-ui, Arial; padding: 16px;">
<h1>Último fallo de conexión</h1>${cuerpo}</body></html>`;
  }

  @Get('qr-view')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  qrView(): string {
    const { status, qr } = this.wwebjsService.getQr();

    const initialImgTag = qr
      ? `<img id="qrimg" src="${qr}" alt="WhatsApp QR" style="width: 320px; height: 320px; image-rendering: pixelated;" />`
      : `<div id="noqr">No hay un QR disponible en este momento.</div>`;

    return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>WhatsApp QR</title>
  </head>
  <body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; padding: 16px;">
    <h1>WhatsApp QR</h1>
    <p>Estado: <strong id="status">${status}</strong></p>
    <div id="container">${initialImgTag}</div>

    <script>
      const container = document.getElementById('container');
      const statusEl = document.getElementById('status');

      async function refreshQr() {
        try {
          const res = await fetch('/whatsapp/qr', { cache: 'no-store' });
          const data = await res.json();
          statusEl.textContent = data.status || 'unknown';

          if (data.qrAgeSeconds !== undefined) {
            statusEl.textContent += ' (QR generado hace ' + data.qrAgeSeconds + ' s)';
          }
          if (data.lastError) {
            statusEl.textContent += ' — último error: ' + data.lastError.message +
              ' (' + new Date(data.lastError.at).toLocaleTimeString('es-AR') + ')';
          }

          if (data.qr) {
            let img = document.getElementById('qrimg');
            if (!img) {
              container.innerHTML = '<img id="qrimg" alt="WhatsApp QR" style="width: 320px; height: 320px; image-rendering: pixelated;" />';
              img = document.getElementById('qrimg');
            }
            img.src = data.qr;
          } else {
            container.innerHTML = data.status === 'qr_expirado'
              ? '<div id="noqr">El QR anterior venció y el bot se está reconectando. Esperá a que aparezca uno nuevo.</div>'
              : '<div id="noqr">No hay un QR disponible en este momento.</div>';
          }
        } catch (e) {
          statusEl.textContent = 'error';
        }
      }

      refreshQr();
      setInterval(refreshQr, 3000);
    </script>
  </body>
</html>`;
  }
}
