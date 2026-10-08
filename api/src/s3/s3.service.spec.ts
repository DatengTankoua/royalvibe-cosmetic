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

function file(originalname: string): Express.Multer.File {
  return {
    originalname,
    buffer: Buffer.from('fake'),
    mimetype: 'image/jpeg',
  } as Express.Multer.File;
}

const PRODUCTS_A = 'organizations/aaaaaaaaaaaaaaaaaaaaaaaa/products';
const PRODUCTS_B = 'organizations/bbbbbbbbbbbbbbbbbbbbbbbb/products';

describe('S3Service', () => {
  beforeEach(() => {
    mockSend.mockClear();
  });

  it('should be defined', () => {
    expect(createService()).toBeDefined();
  });

  describe('uploadFile — clé préfixée par tenant', () => {
    it('construit une clé sous exactement le préfixe fourni par l’appelant', async () => {
      const service = createService();
      const url = await service.uploadFile(file('photo.jpg'), PRODUCTS_A);
      expect(url).toMatch(
        new RegExp(
          `^http://localhost:9000/heyama-objects/${PRODUCTS_A}/[0-9a-f-]+-photo\\.jpg$`,
        ),
      );
      const [command] = mockSend.mock.calls[0] as [{ input: unknown }];
      expect(
        (command.input as { Key: string }).Key.startsWith(`${PRODUCTS_A}/`),
      ).toBe(true);
    });

    it('deux organisations distinctes obtiennent des préfixes de clé distincts', async () => {
      const service = createService();
      const urlA = await service.uploadFile(file('photo.jpg'), PRODUCTS_A);
      const urlB = await service.uploadFile(file('photo.jpg'), PRODUCTS_B);
      expect(urlA).toContain(`${PRODUCTS_A}/`);
      expect(urlB).toContain(`${PRODUCTS_B}/`);
      expect(urlA.includes(PRODUCTS_B)).toBe(false);
      expect(urlB.includes(PRODUCTS_A)).toBe(false);
    });

    it('builds the public URL from S3_ENDPOINT when S3_PUBLIC_URL is not set', async () => {
      const service = createService();
      const url = await service.uploadFile(file('photo.jpg'), PRODUCTS_A);
      expect(url).toMatch(
        /^http:\/\/localhost:9000\/heyama-objects\/.+-photo\.jpg$/,
      );
    });

    it('builds the public URL from S3_PUBLIC_URL when set (e.g. Supabase)', async () => {
      const service = createService({
        S3_PUBLIC_URL:
          'https://proj.supabase.co/storage/v1/object/public/heyama-objects/',
      });
      const url = await service.uploadFile(file('photo.jpg'), PRODUCTS_A);
      expect(url).toMatch(
        /^https:\/\/proj\.supabase\.co\/storage\/v1\/object\/public\/heyama-objects\/.+-photo\.jpg$/,
      );
    });
  });

  describe('uploadFile — sanitisation du nom de fichier', () => {
    it.each([
      ['../../etc/passwd', 'passwd'],
      ['..\\..\\windows\\evil.exe', 'evil.exe'],
      ['a/b/c.png', 'c.png'],
      ['a\\b\\c.png', 'c.png'],
      ['mon fichier avec espaces.png', 'mon-fichier-avec-espaces.png'],
      ['photo café été.jpg', 'photo-caf-t.jpg'],
      ['\u0000\u0001control.png', 'control.png'],
      ['...', 'file'],
      ['', 'file'],
    ])(
      'neutralise "%s" en clé sûre se terminant par "%s"',
      async (input, expectedSuffix) => {
        const service = createService();
        const url = await service.uploadFile(file(input), PRODUCTS_A);
        const [command] = mockSend.mock.calls[
          mockSend.mock.calls.length - 1
        ] as [{ input: unknown }];
        const key = (command.input as { Key: string }).Key;
        const filenamePart = key.split('/').pop() ?? '';
        // Aucun slash/backslash/".." ni caractère de contrôle ne survit
        // dans le SEGMENT nom de fichier (le préfixe org/products, lui,
        // contient légitimement des "/").
        // eslint-disable-next-line no-control-regex -- vérifie l'ABSENCE de caractères de contrôle
        expect(filenamePart).not.toMatch(/[\\]|\.\.|[\x00-\x1f\x7f]/);
        expect(key.endsWith(expectedSuffix)).toBe(true);
        expect(url.endsWith(expectedSuffix)).toBe(true);
      },
    );
  });

  describe('deleteFile — suppression bornée par préfixe de tenant', () => {
    it('supprime la clé A avec la commande bucket/key exacte quand elle appartient au préfixe A', async () => {
      const service = createService();
      await service.deleteFile(
        `http://localhost:9000/heyama-objects/${PRODUCTS_A}/abc-photo.jpg`,
        PRODUCTS_A,
      );
      expect(mockSend).toHaveBeenCalledTimes(1);
      const [command] = mockSend.mock.calls[0] as [DeleteObjectCommand];
      expect(command.input).toEqual({
        Bucket: 'heyama-objects',
        Key: `${PRODUCTS_A}/abc-photo.jpg`,
      });
    });

    it('refuse de supprimer une clé de l’organisation B avec le préfixe A : DeleteObject jamais appelé', async () => {
      const service = createService();
      await service.deleteFile(
        `http://localhost:9000/heyama-objects/${PRODUCTS_B}/abc-photo.jpg`,
        PRODUCTS_A,
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuse une clé legacy plate (sans préfixe organisationnel)', async () => {
      const service = createService();
      await service.deleteFile(
        'http://localhost:9000/heyama-objects/abc-legacy.jpg',
        PRODUCTS_A,
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuse une URL malformée/hors bucket (clé introuvable)', async () => {
      const service = createService();
      await service.deleteFile(
        'https://totally-unrelated.example.com/whatever.jpg',
        PRODUCTS_A,
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('n’utilise jamais un startsWith nu : un préfixe voisin sans séparateur ne matche pas', async () => {
      const service = createService();
      const neighbourOrgPrefix =
        'organizations/aaaaaaaaaaaaaaaaaaaaaaaaXX/products';
      await service.deleteFile(
        `http://localhost:9000/heyama-objects/${neighbourOrgPrefix}/abc.jpg`,
        PRODUCTS_A,
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuse une origine étrangère même si bucket et préfixe apparaissent dans le chemin (évite le split naïf)', async () => {
      const service = createService();
      await service.deleteFile(
        `https://evil.example/heyama-objects/${PRODUCTS_A}/victim.jpg`,
        PRODUCTS_A,
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuse un chemin de base voisin sur la MÊME origine (bucket différent du bucket réellement configuré)', async () => {
      const service = createService();
      await service.deleteFile(
        `http://localhost:9000/heyama-objects-other/${PRODUCTS_A}/abc.jpg`,
        PRODUCTS_A,
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuse une URL portant des credentials embarqués', async () => {
      const service = createService();
      await service.deleteFile(
        `http://attacker:secret@localhost:9000/heyama-objects/${PRODUCTS_A}/abc.jpg`,
        PRODUCTS_A,
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuse un encodage invalide dans le chemin', async () => {
      const service = createService();
      await service.deleteFile(
        `http://localhost:9000/heyama-objects/${PRODUCTS_A}/%E0%A4%A`,
        PRODUCTS_A,
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('respecte le chemin de base Supabase complet (pas seulement le nom du bucket)', async () => {
      const service = createService({
        S3_PUBLIC_URL:
          'https://proj.supabase.co/storage/v1/object/public/heyama-objects/',
      });
      await service.deleteFile(
        `https://proj.supabase.co/storage/v1/object/public/heyama-objects/${PRODUCTS_A}/abc.jpg`,
        PRODUCTS_A,
      );
      expect(mockSend).toHaveBeenCalledTimes(1);
      const [command] = mockSend.mock.calls[0] as [DeleteObjectCommand];
      expect(command.input).toEqual({
        Bucket: 'heyama-objects',
        Key: `${PRODUCTS_A}/abc.jpg`,
      });
    });
  });

  const BRANDING_A = 'organizations/aaaaaaaaaaaaaaaaaaaaaaaa/branding';
  const BRANDING_B = 'organizations/bbbbbbbbbbbbbbbbbbbbbbbb/branding';

  describe('uploadStoredFile — {key,url} (1-8A)', () => {
    it('retourne une clé sous le préfixe fourni et une URL cohérente avec cette clé', async () => {
      const service = createService();
      const { key, url } = await service.uploadStoredFile(
        file('logo.png'),
        BRANDING_A,
      );
      expect(key.startsWith(`${BRANDING_A}/`)).toBe(true);
      expect(key.endsWith('logo.png')).toBe(true);
      expect(url).toBe(`http://localhost:9000/heyama-objects/${key}`);
    });

    it('appelle PutObjectCommand exactement comme uploadFile (même mécanisme)', async () => {
      const service = createService();
      await service.uploadStoredFile(file('logo.png'), BRANDING_A);
      expect(mockSend).toHaveBeenCalledTimes(1);
      const [command] = mockSend.mock.calls[0] as [{ input: unknown }];
      expect(
        (command.input as { Key: string }).Key.startsWith(`${BRANDING_A}/`),
      ).toBe(true);
    });
  });

  describe('publicUrlForKey (1-8A)', () => {
    it('déduit l’URL publique d’une clé déjà connue, sans appel réseau', () => {
      const service = createService();
      expect(service.publicUrlForKey(`${BRANDING_A}/logo.png`)).toBe(
        `http://localhost:9000/heyama-objects/${BRANDING_A}/logo.png`,
      );
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('deleteStoredKey — suppression par clé déjà connue (1-8A)', () => {
    it('supprime une clé appartenant exactement au préfixe autorisé', async () => {
      const service = createService();
      await service.deleteStoredKey(`${BRANDING_A}/old.png`, BRANDING_A);
      expect(mockSend).toHaveBeenCalledTimes(1);
      const [command] = mockSend.mock.calls[0] as [DeleteObjectCommand];
      expect(command.input).toEqual({
        Bucket: 'heyama-objects',
        Key: `${BRANDING_A}/old.png`,
      });
    });

    it('refuse une clé de l’organisation B avec le préfixe A : jamais appelé', async () => {
      const service = createService();
      await service.deleteStoredKey(`${BRANDING_B}/old.png`, BRANDING_A);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuse un préfixe voisin sans séparateur (jamais un startsWith nu)', async () => {
      const service = createService();
      const neighbour = 'organizations/aaaaaaaaaaaaaaaaaaaaaaaaXX/branding';
      await service.deleteStoredKey(`${neighbour}/old.png`, BRANDING_A);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuse une clé plate (legacy, sans préfixe)', async () => {
      const service = createService();
      await service.deleteStoredKey('legacy-logo.png', BRANDING_A);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
