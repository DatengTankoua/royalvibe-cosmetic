import { ConfigService } from '@nestjs/config';
import type {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  S3Service,
  StorageConfigError,
  storageIdentity,
} from './s3.service';

const mockSend = jest.fn().mockResolvedValue({});
const mockGetSignedUrl = jest.fn(
  (
    _client: unknown,
    command: GetObjectCommand,
    options: { expiresIn: number },
  ) =>
    Promise.resolve(
      `https://signed.example/${command.input.Key}?X-Amz-Expires=${options.expiresIn}`,
    ),
);

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

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (
    client: unknown,
    command: GetObjectCommand,
    options: { expiresIn: number },
  ) => mockGetSignedUrl(client, command, options),
}));

const ENDPOINT = 'https://account123.eu.r2.cloudflarestorage.com';
const STORAGE = 'account123.eu.r2.cloudflarestorage.com/stockmaster-prod';

function createService(overrides: Record<string, string> = {}): S3Service {
  const config: Record<string, string> = {
    S3_BUCKET: 'stockmaster-prod',
    S3_ENDPOINT: ENDPOINT,
    S3_REGION: 'auto',
    S3_ACCESS_KEY: 'fake-access',
    S3_SECRET_KEY: 'fake-secret',
    ...overrides,
  };
  return new S3Service({
    get: (key: string) => config[key],
  } as ConfigService);
}

const PRODUCTS_A = 'organizations/aaaaaaaaaaaaaaaaaaaaaaaa/products';
const PRODUCTS_B = 'organizations/bbbbbbbbbbbbbbbbbbbbbbbb/products';
const IMAGE = { extension: 'jpg', contentType: 'image/jpeg' };

describe('S3Service (R2 privé)', () => {
  beforeEach(() => {
    mockSend.mockClear();
    mockSend.mockResolvedValue({});
    mockGetSignedUrl.mockClear();
  });

  describe('identité du stockage', () => {
    it('hôte (+ chemin) de l’endpoint et bucket ; juridiction comprise', () => {
      expect(storageIdentity(ENDPOINT, 'stockmaster-prod')).toBe(STORAGE);
      expect(
        storageIdentity('https://ACCOUNT123.r2.cloudflarestorage.com/', 'b'),
      ).toBe('account123.r2.cloudflarestorage.com/b');
      expect(
        storageIdentity('https://proj.supabase.co/storage/v1/s3', 'royal'),
      ).toBe('proj.supabase.co/storage/v1/s3/royal');
    });

    it('autre juridiction, autre compte ou autre bucket : identités distinctes', () => {
      const ids = new Set([
        storageIdentity(ENDPOINT, 'stockmaster-prod'),
        storageIdentity(
          'https://account123.r2.cloudflarestorage.com',
          'stockmaster-prod',
        ),
        storageIdentity(ENDPOINT, 'autre'),
      ]);
      expect(ids.size).toBe(3);
    });

    it('endpoint ou bucket absent / invalide : aucune identité', () => {
      expect(storageIdentity(undefined, 'b')).toBeNull();
      expect(storageIdentity(ENDPOINT, undefined)).toBeNull();
      expect(storageIdentity('pas une url', 'b')).toBeNull();
    });
  });

  describe('configuration explicite', () => {
    it('durée de signature : 900 s par défaut, valeur entière bornée sinon refus', () => {
      expect(createService().signedUrlTtlSeconds).toBe(
        DEFAULT_SIGNED_URL_TTL_SECONDS,
      );
      expect(
        createService({ S3_SIGNED_URL_TTL_SECONDS: '120' }).signedUrlTtlSeconds,
      ).toBe(120);
      for (const bad of ['59', '3601', '1.5', 'abc']) {
        expect(() => createService({ S3_SIGNED_URL_TTL_SECONDS: bad })).toThrow(
          StorageConfigError,
        );
      }
    });

    it('mode de somme de contrôle : défaut du SDK, when_required explicite, sinon refus', () => {
      expect(() => createService()).not.toThrow();
      expect(() =>
        createService({ S3_CHECKSUM_MODE: 'when_required' }),
      ).not.toThrow();
      expect(() => createService({ S3_CHECKSUM_MODE: 'off' })).toThrow(
        StorageConfigError,
      );
    });
  });

  describe('uploadValidatedImage', () => {
    it('clé serveur sous le préfixe exact, ContentType canonique, identité du stockage renvoyée', async () => {
      const ref = await createService().uploadValidatedImage(
        Buffer.from('x'),
        PRODUCTS_A,
        IMAGE,
      );
      expect(ref.storage).toBe(STORAGE);
      expect(ref.key).toMatch(
        new RegExp(`^${PRODUCTS_A}/[0-9a-f-]{36}\\.jpg$`),
      );
      const command = mockSend.mock.calls[0][0] as PutObjectCommand;
      expect(command.input).toMatchObject({
        Bucket: 'stockmaster-prod',
        Key: ref.key,
        ContentType: 'image/jpeg',
      });
      // Aucune ACL (non implémentée par R2) : le bucket reste privé.
      expect(command.input).not.toHaveProperty('ACL');
    });

    it('stockage non configuré : aucun envoi', async () => {
      await expect(
        createService({ S3_ENDPOINT: '' }).uploadValidatedImage(
          Buffer.from('x'),
          PRODUCTS_A,
          IMAGE,
        ),
      ).rejects.toThrow();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('signedReadUrl — lecture privée', () => {
    it('signe la clé du stockage courant sous le préfixe exact, avec la durée explicite', async () => {
      const url = await createService().signedReadUrl(
        { key: `${PRODUCTS_A}/k.jpg`, storage: STORAGE },
        PRODUCTS_A,
      );
      expect(url).toBe(
        `https://signed.example/${PRODUCTS_A}/k.jpg?X-Amz-Expires=900`,
      );
      const command = mockGetSignedUrl.mock.calls[0][1];
      expect(command.input).toEqual({
        Bucket: 'stockmaster-prod',
        Key: `${PRODUCTS_A}/k.jpg`,
      });
    });

    it.each([
      ['autre organisation', { key: `${PRODUCTS_B}/k.jpg`, storage: STORAGE }],
      [
        'préfixe voisin sans séparateur',
        { key: `${PRODUCTS_A}-legacy/k.jpg`, storage: STORAGE },
      ],
      ['préfixe seul', { key: `${PRODUCTS_A}/`, storage: STORAGE }],
      [
        'autre stockage (ancien fournisseur)',
        { key: `${PRODUCTS_A}/k.jpg`, storage: 'proj.supabase.co/old' },
      ],
      [
        'stockage inconnu (ancien logoKey)',
        { key: `${PRODUCTS_A}/k.jpg`, storage: null },
      ],
    ])('%s → aucune URL, aucune signature', async (_label, ref) => {
      expect(await createService().signedReadUrl(ref, PRODUCTS_A)).toBeNull();
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    });

    it('sans référence : null', async () => {
      expect(await createService().signedReadUrl(null, PRODUCTS_A)).toBeNull();
    });

    it('signature impossible : null, jamais une exception', async () => {
      mockGetSignedUrl.mockRejectedValueOnce(new Error('boom'));
      expect(
        await createService().signedReadUrl(
          { key: `${PRODUCTS_A}/k.jpg`, storage: STORAGE },
          PRODUCTS_A,
        ),
      ).toBeNull();
    });
  });

  describe('deleteStoredObject — après l’écriture MongoDB', () => {
    it('supprime la clé exacte du stockage courant → deleted', async () => {
      const outcome = await createService().deleteStoredObject(
        { key: `${PRODUCTS_A}/k.jpg`, storage: STORAGE },
        PRODUCTS_A,
      );
      expect(outcome).toBe('deleted');
      const command = mockSend.mock.calls[0][0] as DeleteObjectCommand;
      expect(command.input).toEqual({
        Bucket: 'stockmaster-prod',
        Key: `${PRODUCTS_A}/k.jpg`,
      });
    });

    it('aucune référence → not_needed', async () => {
      expect(await createService().deleteStoredObject(null, PRODUCTS_A)).toBe(
        'not_needed',
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each([
      ['autre stockage', { key: `${PRODUCTS_A}/k.jpg`, storage: 'old/b' }],
      ['stockage inconnu', { key: `${PRODUCTS_A}/k.jpg`, storage: null }],
      ['autre organisation', { key: `${PRODUCTS_B}/k.jpg`, storage: STORAGE }],
    ])('%s → retained, aucun appel', async (_label, ref) => {
      expect(await createService().deleteStoredObject(ref, PRODUCTS_A)).toBe(
        'retained',
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('échec du stockage → failed (objet conservé), jamais deleted ni exception', async () => {
      mockSend.mockRejectedValueOnce(new Error('network'));
      expect(
        await createService().deleteStoredObject(
          { key: `${PRODUCTS_A}/k.jpg`, storage: STORAGE },
          PRODUCTS_A,
        ),
      ).toBe('failed');
    });
  });
});
