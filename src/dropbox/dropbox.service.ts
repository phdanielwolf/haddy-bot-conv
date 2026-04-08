// src/services/dropbox.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Dropbox } from 'dropbox';
import axios from 'axios';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

dotenv.config();

@Injectable()
export class DropboxService {
  private dbx: Dropbox;
  private accessToken: string;
  private readonly clientId =
    process.env.DROPBOX_CLIENT_ID || 'cpow7n7oyvjihra';
  private readonly clientSecret =
    process.env.DROPBOX_CLIENT_SECRET || 'd5md6ejppgojy6o';
  private readonly refreshToken =
    process.env.DROPBOX_REFRESH_TOKEN ||
    'bn72Ht6ZTMEAAAAAAAAAAb4iN6J9lmszggLUFWDzDiZYDCHyfI4nRVA-qAfKdQ3r';

  constructor() {
    this.accessToken = ''; // se setea más adelante
  }

  private tokenFilePath = './dropbox_token.json';

  private saveAccessToken(token: string, expiresIn: number) {
    const expiresAt = Date.now() + (expiresIn - 600) * 1000; // le restás 10 minutos por seguridad
    const data = { accessToken: token, expiresAt };
    fs.writeFileSync(this.tokenFilePath, JSON.stringify(data));
  }

  private loadAccessToken(): string | null {
    if (!fs.existsSync(this.tokenFilePath)) return null;

    const raw = fs.readFileSync(this.tokenFilePath, 'utf8');
    const data = JSON.parse(raw);
    if (Date.now() < data.expiresAt) {
      this.accessToken = data.accessToken;
      return data.accessToken;
    }

    return null;
  }

  private async initializeDropbox() {
    const savedToken = this.loadAccessToken();

    if (!savedToken) {
      await this.refreshAccessToken();
    }

    this.dbx = new Dropbox({ accessToken: this.accessToken });
  }

  private async refreshAccessToken(): Promise<void> {
    try {
      const response = await axios.post(
        'https://api.dropboxapi.com/oauth2/token',
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.refreshToken,
        }),
        {
          auth: {
            username: this.clientId,
            password: this.clientSecret,
          },
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      this.accessToken = response.data.access_token;
      this.saveAccessToken(this.accessToken, response.data.expires_in);
      this.dbx = new Dropbox({ accessToken: this.accessToken });
      Logger.log('Dropbox token renovado exitosamente');
    } catch (error) {
      Logger.error(
        'Error renovando token de Dropbox:',
        error.response?.data || error.message,
      );
      throw error;
    }
  }

  private normalizeName(name: string): string {
    return name
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/\b\w/g, (l) => l.toUpperCase());
  }

  async uploadFile(
    filePath: string,
    fileName: string,
    ambulanceName: string,
  ): Promise<string> {
    await this.initializeDropbox();

    //const folderName = this.normalizeName(ambulanceName);
    const now = new Date();
    const formattedDate = `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`;
    const dropboxPath = `/SynergIA/Capital Humano/${formattedDate}/${fileName}`;
    const fileContent = fs.readFileSync(filePath);

    try {
      await this.dbx.filesUpload({
        path: dropboxPath,
        contents: fileContent,
        mode: { '.tag': 'overwrite' },
      });
    } catch (error) {
      if (error?.status === 401) {
        Logger.warn('Token expirado. Renovando…');
        await this.refreshAccessToken();
        await this.dbx.filesUpload({
          path: dropboxPath,
          contents: fileContent,
          mode: { '.tag': 'overwrite' },
        });
      } else {
        throw error;
      }
    }

    return this.createSharedLink(dropboxPath);
  }

  private async createSharedLink(path: string): Promise<string> {
    try {
      const links = await this.dbx.sharingListSharedLinks({ path });
      if (links.result.links.length > 0) {
        return links.result.links[0].url.replace('?dl=0', '?raw=1');
      }

      const res = await this.dbx.sharingCreateSharedLinkWithSettings({ path });
      return res.result.url.replace('?dl=0', '?raw=1');
    } catch (error) {
      Logger.error('Error creando link compartido:', error.message);
      throw error;
    }
  }
}
