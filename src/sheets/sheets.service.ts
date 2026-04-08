import { Injectable, OnModuleInit } from '@nestjs/common';
import { google, sheets_v4, Auth } from 'googleapis';

@Injectable()
export class SheetsService implements OnModuleInit {
  private sheets: sheets_v4.Sheets;

  async onModuleInit() {
    const auth = new google.auth.GoogleAuth({
      keyFile: 'credentials/google-credentials.json',
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const authClient = (await auth.getClient()) as Auth.OAuth2Client;
    this.sheets = google.sheets({ version: 'v4', auth: authClient });
  }

  async leerRango(
    sheetId: string | undefined,
    rango: string,
  ): Promise<string[][]> {
    try {
      const res = await this.sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: rango,
      });
      //console.log('Respuesta completa:', res.data);

      //console.log('[SheetsService] Respuesta cruda:', JSON.stringify(res.data, null, 2));

      if (!res.data || !res.data.values) {
        console.warn('[SheetsService] No hay datos en ese rango.');
        return [];
      }

      return res.data.values;
    } catch (error) {
      console.error('[SheetsService] Error al leer la hoja:', error.message);
      return [];
    }
  }
}
