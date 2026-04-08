import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity()
export class Question {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('text')
  questionText: string; // contenido del mensaje (body)

  @CreateDateColumn()
  createdAt: Date;

  @Column({ nullable: true })
  userId?: string; // identificador de usuario personalizado, si lo usás

  @Column({ nullable: true })
  platform?: string; // WhatsApp, Telegram, etc.

  @Column({ nullable: true, type: 'text' })
  response?: string; // respuesta generada por el bot

  @Column({ nullable: true })
  messageFrom?: string; // número del remitente (from)

  @Column({ nullable: true })
  messageTo?: string; // número del destinatario (to)

  @Column({ nullable: true })
  chatId?: string; // ID único del chat

  @Column({ nullable: true })
  isGroupMsg?: boolean;

  @Column({ nullable: true })
  isMedia?: boolean;

  @Column({ nullable: true })
  messageType?: string; // tipo de mensaje (chat, image, etc.)

  @Column({ nullable: true })
  caption?: string; // si es un medio, el texto adjunto

  @Column({ nullable: true, type: 'text' })
  filename?: string; // nombre del archivo (si lo hay)

  @Column({ nullable: true })
  mimetype?: string; // tipo MIME del archivo (opcional)

  @Column({ nullable: true })
  clientUrl?: string; // URL temporal del archivo (solo si no lo descargás)

  @Column({ nullable: true })
  senderName?: string; // nombre del remitente (pushname)

  @Column({ nullable: true })
  senderFormattedName?: string;

  @Column({ nullable: true })
  isForwarded?: boolean;

  @Column({ nullable: true })
  timestamp?: number; // timestamp original

  @Column({ nullable: true })
  quotedMsgId?: string; // si responde a otro mensaje
}
