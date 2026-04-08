import { Injectable } from '@nestjs/common';
import { google } from 'googleapis';
import { drive_v3 } from 'googleapis/build/src/apis/drive/v3';
import * as fs from 'fs';
import * as path from 'path';
import * as mime from 'mime-types';

@Injectable()
export class GoogleDriveService {
  private drive: drive_v3.Drive;

  constructor() {
    const auth = new google.auth.GoogleAuth({
      keyFile: 'credentials/google-drive-credentials.json',
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    this.drive = google.drive({ version: 'v3', auth });
  }

  private async findOrCreateFolder(
    name: string,
    parentId?: string,
  ): Promise<string> {
    const q =
      `mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false` +
      (parentId ? ` and '${parentId}' in parents` : '');

    const res = await this.drive.files.list({
      q,
      fields: 'files(id, name)',
      spaces: 'drive',
    });

    if (res.data.files?.length) {
      return res.data.files[0].id!;
    }

    const folder = await this.drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : undefined,
      },
      fields: 'id',
    });

    return folder.data.id!;
  }

  async uploadFile(
    filePath: string,
    fileName: string,
    ambulanceName: string,
  ): Promise<string> {
    const parentFolderId = '1GPViPo5DQxWKuXOqlqYq6c-f-lOJaTpc';
    const subFolderId = await this.findOrCreateFolder(
      this.normalizeName(ambulanceName),
      parentFolderId,
    );

    const fileMetadata = {
      name: fileName,
      parents: [subFolderId],
    };

    const media = {
      mimeType: mime.lookup(filePath) || 'application/octet-stream',
      body: fs.createReadStream(filePath),
    };

    const file = await this.drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: 'id',
    });

    await this.drive.permissions.create({
      fileId: file.data.id!,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
    });

    return `https://drive.google.com/uc?id=${file.data.id}`;
  }

  normalizeName(nombre: string): string {
    return nombre
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/\b\w/g, (l) => l.toUpperCase());
  }
}
