import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateInvitationDto } from './create-invitation.dto';
import { OrganizationRole } from '../permissions';

async function collectErrors(plain: Record<string, unknown>) {
  const obj = plainToInstance(CreateInvitationDto, plain, {
    enableImplicitConversion: true,
  });
  return validate(obj, { whitelist: true, forbidNonWhitelisted: true });
}

describe('CreateInvitationDto (mêmes options ValidationPipe que la production)', () => {
  it('accepte un payload valide (role admin, sans permissions)', async () => {
    const errors = await collectErrors({
      email: 'invite@example.com',
      role: 'admin',
    });
    expect(errors).toHaveLength(0);
  });

  it('accepte un payload valide (role seller, permissions déléguables)', async () => {
    const errors = await collectErrors({
      email: 'invite@example.com',
      role: 'seller',
      permissions: ['sales.record', 'sales.view_own'],
    });
    expect(errors).toHaveLength(0);
  });

  it('rejette un email absent ou invalide', async () => {
    expect((await collectErrors({ role: 'admin' })).length).toBeGreaterThan(0);
    expect(
      (await collectErrors({ email: 'nope', role: 'admin' })).length,
    ).toBeGreaterThan(0);
  });

  it('rejette le rôle `owner` (jamais invitable)', async () => {
    const errors = await collectErrors({
      email: 'invite@example.com',
      role: OrganizationRole.OWNER,
    });
    expect(errors.some((e) => e.property === 'role')).toBe(true);
  });

  it('rejette un rôle inconnu', async () => {
    const errors = await collectErrors({
      email: 'invite@example.com',
      role: 'superadmin',
    });
    expect(errors.some((e) => e.property === 'role')).toBe(true);
  });

  it('rejette une permission inconnue (y compris une opération owner-only)', async () => {
    const unknown = await collectErrors({
      email: 'invite@example.com',
      role: 'admin',
      permissions: ['not.a.real.permission'],
    });
    expect(unknown.some((e) => e.property === 'permissions')).toBe(true);

    const ownerOnly = await collectErrors({
      email: 'invite@example.com',
      role: 'admin',
      permissions: ['ownership.transfer'],
    });
    expect(ownerOnly.some((e) => e.property === 'permissions')).toBe(true);
  });

  it('rejette une permission dupliquée', async () => {
    const errors = await collectErrors({
      email: 'invite@example.com',
      role: 'admin',
      permissions: ['sales.record', 'sales.record'],
    });
    expect(errors.some((e) => e.property === 'permissions')).toBe(true);
  });

  it('rejette tout champ inconnu (forbidNonWhitelisted) : organizationId/status/ownerId…', async () => {
    for (const field of ['organizationId', 'status', 'ownerId', 'tokenHash']) {
      const errors = await collectErrors({
        email: 'invite@example.com',
        role: 'admin',
        [field]: 'anything',
      });
      expect(
        errors.some(
          (e) =>
            e.property === field &&
            Object.values(e.constraints ?? {}).some(
              (c) => typeof c === 'string' && c.includes('should not exist'),
            ),
        ),
      ).toBe(true);
    }
  });
});
