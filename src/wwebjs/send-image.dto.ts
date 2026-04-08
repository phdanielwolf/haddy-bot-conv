import { IsString, IsOptional } from 'class-validator';

export class SendImageDto {
  @IsString()
  messageTo: string; // chatId: ej. '5491112345678@c.us' o 'xxx@g.us'

  @IsOptional()
  @IsString()
  caption?: string;

  @IsString()
  imageBase64: string; // data URL: 'data:image/jpeg;base64,...' o base64 puro
}
