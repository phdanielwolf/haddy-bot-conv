// ⚠️ DEBE ir PRIMERO: carga el .env ANTES de importar AppModule. Si no, los
// módulos que leen process.env a nivel de archivo (ej. openai.service.ts hace
// `new OpenAI(...)` al cargarse) corren antes de que dotenv lea el .env y fallan
// con "Missing credentials / OPENAI_API_KEY".
import 'dotenv/config';

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  // Deshabilitamos el body-parser por defecto (límite 100kb) y registramos uno
  // con límite alto para aceptar adjuntos en base64 (imágenes/PDF) que manda
  // Laravel a /baileys/send. Si no, da "PayloadTooLargeError / request entity too large".
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  app.use(json({ limit: '50mb' }));
  app.use(urlencoded({ limit: '50mb', extended: true }));

  const port = Number(process.env.PORT) || 3000;
  await app.listen(port, '0.0.0.0');
}
bootstrap();
