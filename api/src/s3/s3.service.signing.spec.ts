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
