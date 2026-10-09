import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import {
  DEFAULT_INVENTORY_INTERVAL_SECONDS,
  DEFAULT_RECOVERY_INTERVAL_SECONDS,
  DEFAULT_RESERVATION_TTL_SECONDS,
  DEFAULT_STORAGE_QUOTA_BYTES,
  StorageQuotaConfigError,
  parseStorageQuotaConfig,
} from './storage-quota.config';
import { parseStorageQuotaArguments } from '../migrations/storage-quota';
import { StorageQuotaController } from './storage-quota.controller';
import { startStorageRecovery } from './storage-recovery';
import type { StorageQuotaService } from './storage-quota.service';
import { OrganizationRole } from '../organizations/permissions';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import {
  logoKeyPrefix,
  prefixForKind,
  productImagePrefix,
} from './storage-prefixes';

describe('1-17B — configuration des quotas', () => {
  it('défauts : 250 000 000 octets, enforce, réservation 900 s, reprise 600 s', () => {
    expect(parseStorageQuotaConfig({})).toEqual({
      quotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
      mode: 'enforce',
      reservationTtlSeconds: DEFAULT_RESERVATION_TTL_SECONDS,
      recoveryIntervalSeconds: DEFAULT_RECOVERY_INTERVAL_SECONDS,
      inventoryIntervalSeconds: DEFAULT_INVENTORY_INTERVAL_SECONDS,
    });
    expect(DEFAULT_STORAGE_QUOTA_BYTES).toBe(250_000_000);
    expect(DEFAULT_INVENTORY_INTERVAL_SECONDS).toBe(21_600);
  });

  it('valeurs explicites acceptées ; reprise désactivable par 0', () => {
    expect(
      parseStorageQuotaConfig({
        STORAGE_QUOTA_BYTES: '1000',
        STORAGE_QUOTA_MODE: 'track',
        STORAGE_RESERVATION_TTL_SECONDS: '60',
        STORAGE_RECOVERY_INTERVAL_SECONDS: '0',
        STORAGE_INVENTORY_INTERVAL_SECONDS: '0',
      }),
    ).toEqual({
      quotaBytes: 1000,
      mode: 'track',
      reservationTtlSeconds: 60,
      recoveryIntervalSeconds: 0,
      inventoryIntervalSeconds: 0,
    });
  });

  it.each([
    ['STORAGE_QUOTA_BYTES', '0'],
    ['STORAGE_QUOTA_BYTES', '-5'],
    ['STORAGE_QUOTA_BYTES', '250Mo'],
    ['STORAGE_QUOTA_BYTES', '1.5'],
    ['STORAGE_QUOTA_MODE', 'off'],
    ['STORAGE_RESERVATION_TTL_SECONDS', '59'],
    ['STORAGE_RESERVATION_TTL_SECONDS', '3601'],
    ['STORAGE_RECOVERY_INTERVAL_SECONDS', '30'],
    ['STORAGE_INVENTORY_INTERVAL_SECONDS', '299'],
    ['STORAGE_INVENTORY_INTERVAL_SECONDS', '604801'],
  ])('%s=%s → erreur fatale au démarrage', (name, value) => {
    expect(() => parseStorageQuotaConfig({ [name]: value })).toThrow(
      StorageQuotaConfigError,
    );
  });
});

describe('1-17B — préfixes exacts', () => {
  it('photo et logo sous le préfixe de l’organisation', () => {
    const org = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    expect(prefixForKind('product_image', org)).toBe(productImagePrefix(org));
    expect(prefixForKind('logo', org)).toBe(logoKeyPrefix(org));
    expect(productImagePrefix(org)).toBe(`organizations/${org}/products`);
    expect(logoKeyPrefix(org)).toBe(`organizations/${org}/branding`);
  });
});

describe('1-17B — arguments de la CLI storage:quota', () => {
  const ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  it('commandes valides', () => {
    expect(parseStorageQuotaArguments(['diagnose'])).toEqual({
      name: 'diagnose',
      organizationId: undefined,
    });
    expect(
      parseStorageQuotaArguments([
        '--',
        'initialize',
        '--apply',
        `--organization=${ORG}`,
      ]),
    ).toEqual({ name: 'initialize', apply: true, organizationId: ORG });
    expect(parseStorageQuotaArguments(['initialize'])).toEqual({
      name: 'initialize',
      apply: false,
      organizationId: undefined,
    });
    expect(
      parseStorageQuotaArguments(['recover', '--apply', '--limit=20']),
    ).toEqual({
      name: 'recover',
      apply: true,
      organizationId: undefined,
      limit: 20,
    });
    expect(parseStorageQuotaArguments(['recover', '--limit=20'])).toEqual({
      name: 'recover',
      apply: false,
      organizationId: undefined,
      limit: 20,
    });
    expect(parseStorageQuotaArguments(['inventory'])).toEqual({
      name: 'inventory',
      apply: false,
      organizationId: undefined,
    });
    expect(
      parseStorageQuotaArguments([
        'orphans',
        '--apply',
        `--organization=${ORG}`,
      ]),
    ).toEqual({ name: 'orphans', apply: true, organizationId: ORG });
    expect(parseStorageQuotaArguments(['recompute', '--apply'])).toEqual({
      name: 'recompute',
      apply: true,
      organizationId: undefined,
    });
  });

  it.each([
    [[]],
    [['purge']],
    [['diagnose', '--apply']],
    [['initialize', '--organization=xyz']],
    [['recover', '--limit=0']],
    [['recompute', '--force']],
  ])('refus : %j', (argv) => {
    expect(parseStorageQuotaArguments(argv)).toHaveProperty('error');
  });
});

describe('1-17B — GET /organizations/current/storage', () => {
  const ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const usage = jest.fn().mockResolvedValue({ usedBytes: 1 });
  const controller = new StorageQuotaController({
    usage,
  } as unknown as StorageQuotaService);
  const ctx = (
    role: OrganizationRole,
    permissions: ResolvedOrganizationContext['permissions'] = [],
  ): ResolvedOrganizationContext => ({
    userId: '111111111111111111111111',
    organizationId: ORG,
    membershipId: '222222222222222222222222',
    role,
    permissions,
  });

  it('propriétaire et administrateur : organisation du CONTEXTE uniquement', async () => {
    await controller.getUsage(ctx(OrganizationRole.OWNER));
    await controller.getUsage(ctx(OrganizationRole.ADMIN));
    expect(usage).toHaveBeenCalledTimes(2);
    expect(usage).toHaveBeenLastCalledWith(ORG);
  });

  it.each(['products.manage', 'branding.manage', 'trash.manage'] as const)(
    'vendeur délégué %s : autorisé',
    async (permission) => {
      await expect(
        controller.getUsage(ctx(OrganizationRole.SELLER, [permission])),
      ).resolves.toEqual({ usedBytes: 1 });
    },
  );

  it('vendeur sans droit de fichier : 403 PERMISSION_DENIED', () => {
    expect(() => controller.getUsage(ctx(OrganizationRole.SELLER))).toThrow(
      ForbiddenException,
    );
  });
});

describe('1-17B — traitements de fond (reprise, inventaire)', () => {
  const fakeApp = (mode: 'enforce' | 'track', inventory = 300) => {
    const service = {
      config: {
        mode,
        recoveryIntervalSeconds: 60,
        inventoryIntervalSeconds: inventory,
      },
      recover: jest.fn().mockResolvedValue({ examined: 0 }),
      reconcileInventory: jest
        .fn()
        .mockResolvedValue({ totals: {}, deleted: 0, pendingDeletion: 0 }),
    };
    return { service, app: { get: () => service } as never };
  };
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('mode enforce : reprise et inventaire périodiques (avec application)', async () => {
    const { service, app } = fakeApp('enforce');
    const stop = startStorageRecovery(app);
    await jest.advanceTimersByTimeAsync(300_000);
    expect(service.recover).toHaveBeenCalled();
    expect(service.reconcileInventory).toHaveBeenCalledWith({ apply: true });
    stop();
  });

  it('mode track ou inventaire à 0 : aucun inventaire automatique (revue opérateur)', async () => {
    for (const [mode, interval] of [
      ['track', 300],
      ['enforce', 0],
    ] as const) {
      const { service, app } = fakeApp(mode, interval);
      const stop = startStorageRecovery(app);
      await jest.advanceTimersByTimeAsync(600_000);
      expect(service.recover).toHaveBeenCalled();
      expect(service.reconcileInventory).not.toHaveBeenCalled();
      stop();
    }
  });
});
