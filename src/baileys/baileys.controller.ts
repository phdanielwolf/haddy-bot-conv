import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { BaileysService } from './baileys.service';
import { MessageVDto } from '../venom/messagev.dto';

@Controller('baileys')
export class BaileysController {
  constructor(private readonly baileysService: BaileysService) {}

  // 📨 Enviar mensaje a través de Baileys
  @Post('sendmessage')
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() createDto: MessageVDto): Promise<string> {
    return this.baileysService.sendMessage(createDto);
  }

  @Get('sendmessage')
  async findAll(): Promise<string> {
    return 'Baileys WhatsApp API funcionando';
  }

  @Get('status')
  async getStatus(): Promise<any> {
    return this.baileysService.getConnectionStatus();
  }

  @Get('test-connection')
  async testConnection(): Promise<{
    connected: boolean;
    message: string;
    details?: any;
  }> {
    const isConnected = await this.baileysService.testConnection();
    const status = await this.baileysService.getConnectionStatus();

    return {
      connected: isConnected,
      message: isConnected
        ? 'Conexión exitosa con Baileys'
        : 'Sin conexión a WhatsApp',
      details: status,
    };
  }

  @Post('disconnect')
  async disconnect(): Promise<{ message: string }> {
    await this.baileysService.disconnect();
    return {
      message: 'Desconectado exitosamente de WhatsApp',
    };
  }
}
