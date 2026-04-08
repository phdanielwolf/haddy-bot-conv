import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  Query,
  Header,
  HttpCode,
  HttpStatus,
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
  getQr(): { status: string; qr: string | null } {
    return this.wwebjsService.getQr();
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

          if (data.qr) {
            let img = document.getElementById('qrimg');
            if (!img) {
              container.innerHTML = '<img id="qrimg" alt="WhatsApp QR" style="width: 320px; height: 320px; image-rendering: pixelated;" />';
              img = document.getElementById('qrimg');
            }
            img.src = data.qr;
          } else {
            container.innerHTML = '<div id="noqr">No hay un QR disponible en este momento.</div>';
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
