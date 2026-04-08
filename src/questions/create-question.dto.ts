import { IsOptional, IsString, IsBoolean, IsNumber } from 'class-validator';

export class CreateQuestionDto {
  @IsString()
  questionText: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  platform?: string;

  @IsOptional()
  @IsNumber()
  count?: number;

  @IsOptional()
  @IsString()
  response?: string;

  @IsOptional()
  @IsString()
  messageFrom?: string;

  @IsOptional()
  @IsString()
  messageTo?: string;

  @IsOptional()
  @IsString()
  chatId?: string;

  @IsOptional()
  @IsBoolean()
  isGroupMsg?: boolean;

  @IsOptional()
  @IsBoolean()
  isMedia?: boolean;

  @IsOptional()
  @IsString()
  messageType?: string;

  @IsOptional()
  @IsString()
  caption?: string;

  @IsOptional()
  @IsString()
  filename?: string;

  @IsOptional()
  @IsString()
  mimetype?: string;

  @IsOptional()
  @IsString()
  clientUrl?: string;

  @IsOptional()
  @IsString()
  senderName?: string;

  @IsOptional()
  @IsString()
  senderFormattedName?: string;

  @IsOptional()
  @IsBoolean()
  isForwarded?: boolean;

  @IsOptional()
  @IsNumber()
  timestamp?: number;

  @IsOptional()
  @IsString()
  quotedMsgId?: string;
}
