import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

@Injectable()
export class S3Service {
  private readonly s3Client: S3Client;
  private readonly bucket: string;
  private readonly endpoint: string;
  private readonly publicUrlBase: string;

  constructor(private configService: ConfigService) {
    this.bucket = this.configService.get<string>('S3_BUCKET')!;
    this.endpoint = this.configService.get<string>('S3_ENDPOINT')!;
    // Some providers (e.g. Supabase Storage) serve public objects from a
    // different URL than the S3 API endpoint used for authenticated
    // operations. Falls back to the endpoint for S3-compatible servers
    // that serve both from the same origin (e.g. MinIO).
    this.publicUrlBase = (
      this.configService.get<string>('S3_PUBLIC_URL') ??
      `${this.endpoint}/${this.bucket}`
    ).replace(/\/+$/, '');

    this.s3Client = new S3Client({
      endpoint: this.endpoint,
      region: this.configService.get<string>('S3_REGION'),
      credentials: {
        accessKeyId: this.configService.get<string>('S3_ACCESS_KEY')!,
        secretAccessKey: this.configService.get<string>('S3_SECRET_KEY')!,
      },
      forcePathStyle:
        this.configService.get<string>('S3_FORCE_PATH_STYLE') === 'true',
    });
  }

  async uploadFile(file: Express.Multer.File): Promise<string> {
    const key = `${randomUUID()}-${file.originalname}`;

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      }),
    );

    return `${this.publicUrlBase}/${key}`;
  }

  async deleteFile(imageUrl: string): Promise<void> {
    const key = imageUrl.split(`${this.bucket}/`)[1];
    if (!key) return;

    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }
}
