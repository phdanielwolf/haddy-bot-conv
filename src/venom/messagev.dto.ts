import { IsOptional, IsString, IsBoolean } from 'class-validator';

export class MessageVDto {
  @IsString()
  questionText: string;

  @IsOptional()
  @IsString()
  platform?: string;

  @IsOptional()
  @IsString()
  response?: string;

  @IsOptional()
  @IsString()
  messageFrom?: string;

  @IsString()
  messageTo: string;

  @IsOptional()
  @IsBoolean()
  isGroupMsg?: boolean;
}
