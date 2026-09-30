import { Test } from '@nestjs/testing';
import sharp from 'sharp';

/**
 * 1-12D — Politique Sharp du processus API. Les modules sont rechargés dans
 * un registre isolé (`jest.isolateModules`) pour vérifier les appels ; les
 * effets réels sur libvips sont idempotents (même allowlist), donc ces
 * tests ne dépendent pas de l'ordre d'exécution des fichiers.
 */

type PolicyModule = typeof import('./sharp-security-policy');

function loadFresh<T>(path: string): T {
  let mod: T | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- rechargement isolé volontaire
    mod = require(path) as T;
  });
  return mod!;
}

/**
 * Charge `path` dans un registre isolé en espionnant l'instance de Sharp de
 * CE registre (celle que le module chargé utilisera réellement).
 */
function loadFreshWithSpies<T>(path: string) {
  let mod: T | undefined;
  let spies:
    | {
        cache: jest.SpyInstance;
        block: jest.SpyInstance;
        unblock: jest.SpyInstance;
      }
    | undefined;
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-require-imports -- instance de Sharp du registre isolé */
    const isolatedSharp =
      (require('sharp') as { default?: typeof sharp }).default ??
      (require('sharp') as typeof sharp);
    spies = {
      cache: jest.spyOn(isolatedSharp, 'cache'),
      block: jest.spyOn(isolatedSharp, 'block'),
      unblock: jest.spyOn(isolatedSharp, 'unblock'),
    };
    mod = require(path) as T;
    /* eslint-enable @typescript-eslint/no-require-imports */
  });
  return { mod: mod!, spies: spies! };
}

const create = () =>
  sharp({
    create: { width: 8, height: 8, channels: 3, background: '#062b5c' },
  });

describe('configureSharpSecurityPolicy (1-12D)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('idempotente : deux appels → une seule configuration (cache, block, unblock)', () => {
    const {
      mod: policy,
      spies: { cache, block, unblock },
    } = loadFreshWithSpies<PolicyModule>('./sharp-security-policy');

    expect(policy.isSharpSecurityPolicyConfigured()).toBe(false);
    policy.configureSharpSecurityPolicy();
    policy.configureSharpSecurityPolicy();
    expect(policy.isSharpSecurityPolicyConfigured()).toBe(true);

    expect(cache).toHaveBeenCalledTimes(1);
    expect(cache).toHaveBeenCalledWith(false);
    expect(block).toHaveBeenCalledTimes(1);
    expect(block).toHaveBeenCalledWith({ operation: ['VipsForeignLoad'] });
    expect(unblock).toHaveBeenCalledTimes(1);
    expect(unblock).toHaveBeenCalledWith({
      operation: [
        'VipsForeignLoadPngBuffer',
        'VipsForeignLoadWebpBuffer',
        'VipsForeignLoadJpegBuffer',
      ],
    });
  });

  it('allowlist exacte : PNG, WebP, JPEG (buffer) — aucun autre décodeur réactivé', () => {
    const policy = loadFresh<PolicyModule>('./sharp-security-policy');
    expect([...policy.SHARP_ALLOWED_LOADERS]).toEqual([
      'VipsForeignLoadPngBuffer',
      'VipsForeignLoadWebpBuffer',
      'VipsForeignLoadJpegBuffer',
    ]);
  });

  it('import de logo-validation.ts : AUCUNE modification implicite de Sharp', () => {
    const {
      spies: { cache, block, unblock },
    } = loadFreshWithSpies('../../organizations/logo/logo-validation');
    // Témoin : les espions observent bien l'instance utilisée par le module.
    expect(jest.isMockFunction(block)).toBe(true);
    expect(cache).not.toHaveBeenCalled();
    expect(block).not.toHaveBeenCalled();
    expect(unblock).not.toHaveBeenCalled();
  });

  it('provider Nest : appliquée au bootstrap (`app.init()`), jamais à la construction', async () => {
    let policy!: PolicyModule;
    let moduleRef!: typeof import('./image-security.module');
    jest.isolateModules(() => {
      /* eslint-disable @typescript-eslint/no-require-imports -- même registre isolé pour les deux modules */
      policy = require('./sharp-security-policy') as PolicyModule;
      moduleRef = require('./image-security.module') as typeof moduleRef;
      /* eslint-enable @typescript-eslint/no-require-imports */
    });
    const testing = await Test.createTestingModule({
      imports: [moduleRef.ImageSecurityModule],
    }).compile();
    const app = testing.createNestApplication();
    expect(policy.isSharpSecurityPolicyConfigured()).toBe(false);
    await app.init();
    expect(policy.isSharpSecurityPolicyConfigured()).toBe(true);
    await app.close();
  });

  describe('effet réel sur libvips (après configuration)', () => {
    beforeAll(() => {
      loadFresh<PolicyModule>(
        './sharp-security-policy',
      ).configureSharpSecurityPolicy();
    });

    it('PNG, WebP et JPEG restent lisibles', async () => {
      for (const buffer of [
        await create().png().toBuffer(),
        await create().webp().toBuffer(),
        await create().jpeg().toBuffer(),
      ]) {
        await expect(sharp(buffer).metadata()).resolves.toHaveProperty(
          'width',
          8,
        );
      }
    });

    it('SVG, GIF, AVIF, HEIF et TIFF bloqués (jamais décodés par libvips)', async () => {
      const blocked: Array<[string, Buffer]> = [
        [
          'svg',
          Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>',
          ),
        ],
        ['gif', await create().gif().toBuffer()],
        ['avif', await create().avif().toBuffer()],
        ['heif', await create().heif({ compression: 'av1' }).toBuffer()],
        ['tiff', await create().tiff().toBuffer()],
      ];
      for (const [label, buffer] of blocked) {
        await expect(sharp(buffer).metadata()).rejects.toThrow(
          /unsupported image format/,
        );
        expect(label).toBeTruthy();
      }
    });

    it('re-configuration : aucun changement d’état (toujours bloqué / autorisé)', async () => {
      loadFresh<PolicyModule>(
        './sharp-security-policy',
      ).configureSharpSecurityPolicy();
      await expect(
        sharp(await create().gif().toBuffer()).metadata(),
      ).rejects.toThrow();
      await expect(
        sharp(await create().jpeg().toBuffer()).metadata(),
      ).resolves.toHaveProperty('format', 'jpeg');
    });
  });
});
