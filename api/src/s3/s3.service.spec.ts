import { ConfigService } from '@nestjs/config';
import type { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { S3Service } from './s3.service';

const mockSend = jest.fn().mockResolvedValue({});

jest.mock('@aws-sdk/client-s3', () => {
  const actual =
    jest.requireActual<typeof import('@aws-sdk/client-s3')>(
      '@aws-sdk/client-s3',
    );
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  };
});

function createService(overrides: Record<string, string> = {}): S3Service {
  const config: Record<string, string> = {
    S3_BUCKET: 'heyama-objects',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin123',
    S3_FORCE_PATH_STYLE: 'true',
    ...overrides,
  };
  return new S3Service({
    get: (key: string) => config[key],
  } as ConfigService);
}

const mockFile = {
  originalname: 'photo.jpg',
  buffer: Buffer.from('fake'),
  mimetype: 'image/jpeg',
} as Express.Multer.File;

describe('S3Service', () => {
  beforeEach(() => {
    mockSend.mockClear();
  });

  it('should be defined', () => {
    expect(createService()).toBeDefined();
  });

  it('builds the public URL from S3_ENDPOINT when S3_PUBLIC_URL is not set', async () => {
    const service = createService();
    const url = await service.uploadFile(mockFile);
    expect(url).toMatch(
      /^http:\/\/localhost:9000\/heyama-objects\/.+-photo\.jpg$/,
    );
  });

  it('builds the public URL from S3_PUBLIC_URL when set (e.g. Supabase)', async () => {
    const service = createService({
      S3_PUBLIC_URL:
        'https://proj.supabase.co/storage/v1/object/public/heyama-objects/',
    });
    const url = await service.uploadFile(mockFile);
    expect(url).toMatch(
      /^https:\/\/proj\.supabase\.co\/storage\/v1\/object\/public\/heyama-objects\/.+-photo\.jpg$/,
    );
  });

  it('deletes the object using the key extracted from the image URL', async () => {
    const service = createService();
    await service.deleteFile(
      'http://localhost:9000/heyama-objects/abc-photo.jpg',
    );

    expect(mockSend).toHaveBeenCalledTimes(1);
    const [command] = mockSend.mock.calls[0] as [DeleteObjectCommand];
    expect(command.input).toEqual({
      Bucket: 'heyama-objects',
      Key: 'abc-photo.jpg',
    });
  });
});
