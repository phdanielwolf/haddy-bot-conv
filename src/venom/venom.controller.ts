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
import { VenomService } from './venom.service';
import { MessageVDto } from './messagev.dto';

@Controller('venom')
export class VenomController {
  constructor(private readonly venomService: VenomService) {}

  // 📨 Guardar una nueva pregunta (desde el bot o un frontend)
  @Post('sendmessage')
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() createDto: MessageVDto): Promise<string> {
    return this.venomService.sendMessage(createDto);
  }

  @Get('sendmessage')
  async findAll(): Promise<string> {
    return 'hola';
  }

  @Get('status')
  async getStatus(): Promise<string> {
    return this.venomService.getConnectionStatus();
  }

  @Get('test-connection')
  async testConnection(): Promise<{ connected: boolean; message: string }> {
    const isConnected = await this.venomService.testConnection();
    return {
      connected: isConnected,
      message: isConnected ? 'Conexión exitosa' : 'Sin conexión',
    };
  }
}
