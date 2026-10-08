import { ConfigService } from '@nestjs/config';
import { S3Service } from './s3.service';

/**
 * Signature RÉELLE (SDK non simulé, aucun appel réseau : une URL signée se
 * calcule localement). Vérifie la forme de l'URL pour un endpoint R2 avec
 * juridiction, la durée explicite et la date réelle de signature.
 */
const PREFIX = 'organizations/aaaaaaaaaaaaaaaaaaaaaaaa/products';
const KEY = `${PREFIX}/0f8fad5b-d9cb-469f-a165-70867728950e.jpg`;

function service(overrides: Record<string, string> = {}) {
  const config: Record<string, string> = {
    S3_BUCKET: 'stockmaster-prod',
    S3_ENDPOINT: 'https://account123.eu.r2.cloudflarestorage.com',
    S3_REGION: 'auto',
    S3_ACCESS_KEY: 'fake-access',
    S3_SECRET_KEY: 'fake-secret',
    ...overrides,
  };
  return new S3Service({ get: (k: string) => config[k] } as ConfigService);
}

function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

describe('S3Service — URL signée réelle (sans réseau)', () => {
  it('path-style : hôte du compte et juridiction, bucket dans le chemin, région auto, 900 s', async () => {
    const s = service({ S3_FORCE_PATH_STYLE: 'true' });
    const before = new Date(Date.now() - 2000);
    const url = new URL(
      (await s.signedReadUrl({ key: KEY, storage: s.storage }, PREFIX))!,
    );
    const after = new Date(Date.now() + 2000);
    expect(url.host).toBe('account123.eu.r2.cloudflarestorage.com');
    expect(url.pathname).toBe(`/stockmaster-prod/${KEY}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(
      /^fake-access\/\d{8}\/auto\/s3\/aws4_request$/,
    );
    // Date réelle de signature (aucun arrondi).
    const signedAt = url.searchParams.get('X-Amz-Date')!;
    expect(signedAt >= amzDate(before)).toBe(true);
    expect(signedAt <= amzDate(after)).toBe(true);
    // Jamais de secret dans l'URL.
    expect(url.href).not.toContain('fake-secret');
  });

  it('virtual-hosted (défaut, exemple officiel Cloudflare) : bucket en sous-domaine', async () => {
    const s = service();
    const url = new URL(
      (await s.signedReadUrl({ key: KEY, storage: s.storage }, PREFIX))!,
    );
    expect(url.host).toBe(
      'stockmaster-prod.account123.eu.r2.cloudflarestorage.com',
    );
    expect(url.pathname).toBe(`/${KEY}`);
  });

  it('durée configurée explicitement', async () => {
    const s = service({ S3_SIGNED_URL_TTL_SECONDS: '120' });
    const url = new URL(
      (await s.signedReadUrl({ key: KEY, storage: s.storage }, PREFIX))!,
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('120');
  });

  it('mode when_required : aucun x-amz-checksum-mode dans l’URL ; défaut : présent', async () => {
    const strict = service({ S3_CHECKSUM_MODE: 'when_required' });
    const relaxed = service();
    const a = new URL(
      (await strict.signedReadUrl(
        { key: KEY, storage: strict.storage },
        PREFIX,
      ))!,
    );
    const b = new URL(
      (await relaxed.signedReadUrl(
        { key: KEY, storage: relaxed.storage },
        PREFIX,
      ))!,
    );
    expect(a.searchParams.has('x-amz-checksum-mode')).toBe(false);
    expect(b.searchParams.get('x-amz-checksum-mode')).toBe('ENABLED');
  });
});

describe('S3Service — endpoint de signature distinct (Docker Compose/MinIO)', () => {
  const minio = (overrides: Record<string, string> = {}) =>
    service({
      S3_ENDPOINT: 'http://minio:9000',
      S3_BUCKET: 'stockmaster-objects',
      S3_REGION: 'us-east-1',
      S3_FORCE_PATH_STYLE: 'true',
      S3_SIGNING_ENDPOINT: 'https://s3.stock-master.app',
      ...overrides,
    });

  it('URL GET signée pour l’hôte du navigateur ; identité durable = endpoint interne', async () => {
    const s = minio();
    expect(s.storage).toBe('minio:9000/stockmaster-objects');
    const url = new URL(
      (await s.signedReadUrl({ key: KEY, storage: s.storage }, PREFIX))!,
    );
    expect(url.origin).toBe('https://s3.stock-master.app');
    expect(url.pathname).toBe(`/stockmaster-objects/${KEY}`);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });

  it('l’hôte du navigateur ne change pas l’identité : référence existante toujours lisible', async () => {
    const withSigning = minio();
    const internalOnly = minio({ S3_SIGNING_ENDPOINT: '' });
    expect(withSigning.storage).toBe(internalOnly.storage);
    expect(
      await withSigning.signedReadUrl(
        { key: KEY, storage: internalOnly.storage },
        PREFIX,
      ),
    ).not.toBeNull();
  });

  it('sans endpoint de signature (R2) : URL sur l’endpoint unique', async () => {
    const s = service();
    const url = new URL(
      (await s.signedReadUrl({ key: KEY, storage: s.storage }, PREFIX))!,
    );
    expect(url.host).toBe(
      'stockmaster-prod.account123.eu.r2.cloudflarestorage.com',
    );
  });

  it.each([
    'pas une url',
    'ftp://s3.stock-master.app',
    'https://s3.stock-master.app/chemin',
    'https://user:pw@s3.stock-master.app',
    'https://s3.stock-master.app/?x=1',
  ])('valeur invalide refusée au démarrage : %s', (value) => {
    expect(() => minio({ S3_SIGNING_ENDPOINT: value })).toThrow(
      'S3_SIGNING_ENDPOINT',
    );
  });
});
