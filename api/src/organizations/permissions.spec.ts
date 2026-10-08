import {
  DEFAULT_PERMISSIONS_BY_ROLE,
  DelegablePermission,
  effectivePermissions,
  hasPermission,
  isPermissionSubset,
  OrganizationRole,
  STANDARD_MEMBER_PERMISSIONS,
} from './permissions';

/**
 * 1-12H — droits standard (`sales.record`, `sales.view_own`) ajoutés par le
 * calcul central à TOUT membre, et permissions de visibilité produit.
 */
describe('permissions effectives (1-12H)', () => {
  it('droits standard figés : sales.record + sales.view_own uniquement (jamais sales.view_all)', () => {
    expect([...STANDARD_MEMBER_PERMISSIONS].sort()).toEqual([
      'sales.record',
      'sales.view_own',
    ]);
    expect(Object.isFrozen(STANDARD_MEMBER_PERMISSIONS)).toBe(true);
  });

  it.each([
    ['owner', OrganizationRole.OWNER],
    ['admin', OrganizationRole.ADMIN],
    ['seller', OrganizationRole.SELLER],
    ['rôle hors table (défensif)', 'guest' as unknown as OrganizationRole],
  ])(
    '%s : droits standard présents, même avec permissions supplémentaires vides (membership ancienne ou nouvelle)',
    (_label, role) => {
      const effective = effectivePermissions(role, []);
      for (const permission of STANDARD_MEMBER_PERMISSIONS) {
        expect(effective.has(permission)).toBe(true);
      }
    },
  );

  it('une liste de permissions client ne peut pas retirer les droits standard', () => {
    // Même une membership « legacy » stockée sans ces valeurs les conserve.
    const effective = effectivePermissions(OrganizationRole.SELLER, [
      'analytics.read',
    ]);
    expect(effective.has('sales.record')).toBe(true);
    expect(effective.has('sales.view_own')).toBe(true);
    expect(effective.has('sales.view_all')).toBe(false);
  });

  it('seller sans délégation : aucune visibilité produit étendue', () => {
    const ctx = { role: OrganizationRole.SELLER, permissions: [] };
    expect(hasPermission(ctx, 'products.view_stock_details')).toBe(false);
    expect(hasPermission(ctx, 'products.view_financials')).toBe(false);
  });

  it('owner et admin : les deux groupes produit par défaut', () => {
    for (const role of [OrganizationRole.OWNER, OrganizationRole.ADMIN]) {
      expect(DEFAULT_PERMISSIONS_BY_ROLE[role]).toEqual(
        expect.arrayContaining([
          'products.view_stock_details',
          'products.view_financials',
        ]),
      );
    }
  });

  it.each<DelegablePermission>([
    'products.view_stock_details',
    'products.view_financials',
  ])(
    '%s n’accorde ni analytics.read, ni sales.view_all, ni aucun droit de modification',
    (permission) => {
      const effective = effectivePermissions(OrganizationRole.SELLER, [
        permission,
      ]);
      for (const other of [
        'analytics.read',
        'sales.view_all',
        'products.manage',
        'stock.adjust',
        'catalog.manage',
      ] as const) {
        expect(effective.has(other)).toBe(false);
      }
    },
  );

  it('anti-escalade inchangée : un seller délégué members.invite ne peut pas accorder un groupe produit qu’il ne possède pas', () => {
    const actor = effectivePermissions(OrganizationRole.SELLER, [
      'members.invite',
    ]);
    const invited = effectivePermissions(OrganizationRole.SELLER, [
      'products.view_financials',
    ]);
    expect(isPermissionSubset(invited, actor)).toBe(false);
    // Les droits standard seuls restent toujours accordables.
    expect(
      isPermissionSubset(
        effectivePermissions(OrganizationRole.SELLER, []),
        actor,
      ),
    ).toBe(true);
  });
});
