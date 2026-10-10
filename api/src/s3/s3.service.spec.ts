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

    it('1-17B : clé réservée imposée (sous le préfixe) et annulation transmise au client', async () => {
      const service = createService();
      const key = service.newObjectKey(PRODUCTS_A, 'jpg');
      expect(key).toMatch(new RegExp(`^${PRODUCTS_A}/[0-9a-f-]{36}\\.jpg$`));
      const controller = new AbortController();
      const ref = await service.uploadValidatedImage(
        Buffer.from('x'),
        PRODUCTS_A,
        IMAGE,
        { key, abortSignal: controller.signal },
      );
      expect(ref).toEqual({ key, storage: STORAGE });
      expect((mockSend.mock.calls[0][0] as PutObjectCommand).input.Key).toBe(
        key,
      );
      expect(mockSend.mock.calls[0][1]).toEqual({
        abortSignal: controller.signal,
      });
    });

    it('1-17B : clé imposée hors du préfixe exact → refus, aucun envoi', async () => {
      await expect(
        createService().uploadValidatedImage(
          Buffer.from('x'),
          PRODUCTS_A,
          IMAGE,
          {
            key: `${PRODUCTS_B}/x.jpg`,
          },
        ),
      ).rejects.toThrow();
      await expect(
        createService().uploadValidatedImage(
          Buffer.from('x'),
          PRODUCTS_A,
          IMAGE,
          {
            key: `${PRODUCTS_A}extra/x.jpg`,
          },
        ),
      ).rejects.toThrow();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('1-17B listStoredObjects — inventaire sous organizations/', () => {
    it('page du stockage courant : clé, taille, date ; continuation transmise', async () => {
      const date = new Date('2026-10-01T00:00:00Z');
      mockSend.mockResolvedValueOnce({
        Contents: [
          { Key: `${PRODUCTS_A}/a.jpg`, Size: 12, LastModified: date },
        ],
        IsTruncated: true,
        NextContinuationToken: 'tok',
      });
      const page = await createService().listStoredObjects(
        'organizations/',
        'prev',
      );
      expect(page).toEqual({
        objects: [
          { key: `${PRODUCTS_A}/a.jpg`, bytes: 12, lastModified: date },
        ],
        next: 'tok',
      });
      const command = mockSend.mock.calls[0][0] as {
        constructor: { name: string };
        input: Record<string, unknown>;
      };
      expect(command.constructor.name).toBe('ListObjectsV2Command');
      expect(command.input).toMatchObject({
        Bucket: 'stockmaster-prod',
        Prefix: 'organizations/',
        ContinuationToken: 'prev',
      });
    });

    it('préfixe hors organizations/ (racine du bucket) → refus, aucun appel', async () => {
      await expect(createService().listStoredObjects('')).rejects.toThrow();
      await expect(
        createService().listStoredObjects('autre/'),
      ).rejects.toThrow();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('taille absente → échec (jamais une taille supposée)', async () => {
      mockSend.mockResolvedValueOnce({
        Contents: [{ Key: `${PRODUCTS_A}/a` }],
      });
      await expect(
        createService().listStoredObjects('organizations/'),
      ).rejects.toThrow();
    });
  });

  describe('1-17B headStoredObject — taille vérifiée sans téléchargement', () => {
    const REF = { key: `${PRODUCTS_A}/a.jpg`, storage: STORAGE };

    it('présent : Content-Length du stockage (HeadObject, jamais GetObject)', async () => {
      mockSend.mockResolvedValueOnce({ ContentLength: 1234 });
      await expect(
        createService().headStoredObject(REF, PRODUCTS_A),
      ).resolves.toEqual({ state: 'present', bytes: 1234 });
      expect(mockSend.mock.calls[0][0].constructor.name).toBe(
        'HeadObjectCommand',
      );
    });

    it('404 : absence confirmée', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('NotFound'), {
          name: 'NotFound',
          $metadata: { httpStatusCode: 404 },
        }),
      );
      await expect(
        createService().headStoredObject(REF, PRODUCTS_A),
      ).resolves.toEqual({ state: 'absent' });
    });

    it('erreur réseau/droits ou taille absente : inconnue (jamais 0 ni absent)', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('denied'), {
          $metadata: { httpStatusCode: 403 },
        }),
      );
      mockSend.mockResolvedValueOnce({});
      const service = createService();
      await expect(service.headStoredObject(REF, PRODUCTS_A)).resolves.toEqual({
        state: 'unknown',
      });
      await expect(service.headStoredObject(REF, PRODUCTS_A)).resolves.toEqual({
        state: 'unknown',
      });
    });

    it('autre stockage ou autre préfixe : non consulté', async () => {
      const service = createService();
      await expect(
        service.headStoredObject({ ...REF, storage: 'autre/b' }, PRODUCTS_A),
      ).resolves.toEqual({ state: 'retained' });
      await expect(service.headStoredObject(REF, PRODUCTS_B)).resolves.toEqual({
        state: 'retained',
      });
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

  describe('signedReadUrl — réutilisation bornée (1-20C)', () => {
    const REF_A = { key: `${PRODUCTS_A}/k.jpg`, storage: STORAGE };
    let clock: jest.SpyInstance<number, []>;
    let t = 0;
    beforeEach(() => {
      t = Date.UTC(2026, 9, 10, 12);
      clock = jest.spyOn(Date, 'now').mockImplementation(() => t);
    });
    afterEach(() => clock.mockRestore());

    it('même objet : une seule signature pendant le tiers de la validité, puis une nouvelle', async () => {
      const service = createService();
      const first = await service.signedReadUrl(REF_A, PRODUCTS_A);
      t += 299_999;
      expect(await service.signedReadUrl(REF_A, PRODUCTS_A)).toBe(first);
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
      t += 1; // 300 s = 900 s / 3
      await service.signedReadUrl(REF_A, PRODUCTS_A);
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(2);
    });

    it('fenêtre proportionnelle à la durée configurée (600 s → 200 s)', async () => {
      const service = createService({ S3_SIGNED_URL_TTL_SECONDS: '600' });
      await service.signedReadUrl(REF_A, PRODUCTS_A);
      t += 199_999;
      await service.signedReadUrl(REF_A, PRODUCTS_A);
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
      t += 1;
      await service.signedReadUrl(REF_A, PRODUCTS_A);
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(2);
    });

    it('nouvelle photo (nouvelle clé) : nouvelle URL ; objets distincts jamais confondus', async () => {
      const service = createService();
      const before = await service.signedReadUrl(REF_A, PRODUCTS_A);
      const replaced = await service.signedReadUrl(
        { key: `${PRODUCTS_A}/k2.jpg`, storage: STORAGE },
        PRODUCTS_A,
      );
      expect(replaced).not.toBe(before);
      expect(replaced).toContain(`${PRODUCTS_A}/k2.jpg`);
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(2);
    });

    it('cache chaud : contrôles de stockage et de périmètre toujours appliqués', async () => {
      const service = createService();
      expect(await service.signedReadUrl(REF_A, PRODUCTS_A)).not.toBeNull();
      // Même clé, mais demandée dans le périmètre d'une autre organisation.
      expect(await service.signedReadUrl(REF_A, PRODUCTS_B)).toBeNull();
      // Même clé, autre stockage déclaré.
      expect(
        await service.signedReadUrl(
          { ...REF_A, storage: 'proj.supabase.co/old' },
          PRODUCTS_A,
        ),
      ).toBeNull();
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
    });

    it('échec puis nouvel essai : rien en cache après un échec', async () => {
      const service = createService();
      mockGetSignedUrl.mockRejectedValueOnce(new Error('boom'));
      expect(await service.signedReadUrl(REF_A, PRODUCTS_A)).toBeNull();
      expect(await service.signedReadUrl(REF_A, PRODUCTS_A)).toBe(
        `https://signed.example/${PRODUCTS_A}/k.jpg?X-Amz-Expires=900`,
      );
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(2);
    });

    it('appels simultanés : une seule signature', async () => {
      const service = createService();
      const urls = await Promise.all(
        Array.from({ length: 8 }, () =>
          service.signedReadUrl(REF_A, PRODUCTS_A),
        ),
      );
      expect(new Set(urls).size).toBe(1);
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
    });

    it('instances (configurations) distinctes : aucun partage', async () => {
      await createService().signedReadUrl(REF_A, PRODUCTS_A);
      await createService({
        S3_SIGNING_ENDPOINT: 'https://s3.example.com',
      }).signedReadUrl(REF_A, PRODUCTS_A);
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(2);
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
