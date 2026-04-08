import { Injectable } from '@nestjs/common';
import { recognize } from 'tesseract.js';
import * as faceapi from 'face-api.js';
import * as canvas from 'canvas';
import * as path from 'path';
import * as sharp from 'sharp';

const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

@Injectable()
export class ImageAnalysisService {
  private initialized = false;

  async analyzeImage(imagePath: string) {
    const [textData, faceDetected] = await Promise.all([
      this.extractText(imagePath),
      this.detectFace(imagePath),
    ]);

    const parsedData = this.parseCoordinatesAndDate(textData);

    return {
      ...parsedData,
      faceDetected,
    };
  }

  private async extractText(imagePath: string): Promise<string> {
    const preprocessedBuffer = await sharp(imagePath)
      .grayscale()
      .normalize()
      .threshold(150)
      .sharpen()
      .toBuffer();

    const {
      data: { text },
    } = await recognize(preprocessedBuffer, 'eng+spa', {
      logger: (m) => console.log('📊 Tesseract:', m),
    });

    console.log('🧾 Texto detectado por OCR:\n', text);
    return text;
  }

  private parseCoordinatesAndDate(text: string): {
    date: string | null;
    lat: number | null;
    lng: number | null;
  } {
    const regex =
      /(\d{1,2}\/\d{1,2}\/\d{4})\s*(\d{2}:\d{2}:\d{2})[\s\S]*?(-?\d{1,2}\.\d+)[^\d-]+(-?\d{1,3}\.\d+)/;

    const match = text.match(regex);
    console.log('🧾 Coincidencia encontrada:', match);

    if (!match) {
      return {
        date: null,
        lat: null,
        lng: null,
      };
    }

    const [, dateStr, timeStr, latStr, lngStr] = match;

    return {
      date: `${dateStr} ${timeStr}`,
      lat: parseFloat(latStr),
      lng: parseFloat(lngStr),
    };
  }

  private async detectFace(imagePath: string): Promise<boolean> {
    if (!this.initialized) {
      const MODEL_PATH = path.join(__dirname, '../../models');
      console.log('📦 Cargando modelos desde:', MODEL_PATH);

      try {
        await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_PATH);
        this.initialized = true;
        console.log('✅ Modelo cargado correctamente');
      } catch (error) {
        console.error(
          '❌ Error al cargar modelo de reconocimiento facial:',
          error,
        );
        this.initialized = false;
      }
    }

    const img = await canvas.loadImage(imagePath);
    const detections = await faceapi.detectAllFaces(img);

    return detections.length > 0;
  }
}
