import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AcceptInvitationDto } from './accept-invitation.dto';

async function collectErrors(plain: Record<string, unknown>) {
  const obj = plainToInstance(AcceptInvitationDto, plain, {
    enableImplicitConversion: true,
  });
  return validate(obj, { whitelist: true, forbidNonWhitelisted: true });
}

describe('AcceptInvitationDto (mêmes options ValidationPipe que la production)', () => {
  it('accepte { token } seul (name/password optionnels au DTO)', async () => {
    const errors = await collectErrors({ token: 'raw-token' });
    expect(errors).toHaveLength(0);
  });

  it('accepte { token, name, password }', async () => {
    const errors = await collectErrors({
      token: 'raw-token',
      name: 'Ada',
      password: 'secret-123',
    });
    expect(errors).toHaveLength(0);
  });

  it('rejette un token absent ou vide', async () => {
    expect((await collectErrors({})).length).toBeGreaterThan(0);
    expect((await collectErrors({ token: '' })).length).toBeGreaterThan(0);
  });

  it('rejette un password trop court (< 6)', async () => {
    const errors = await collectErrors({
      token: 'raw-token',
      password: 'x1234',
    });
    expect(errors.some((e) => e.property === 'password')).toBe(true);
  });

  it('rejette un name vide', async () => {
    const errors = await collectErrors({ token: 'raw-token', name: '' });
    expect(errors.some((e) => e.property === 'name')).toBe(true);
  });

  it('rejette tout champ inconnu (forbidNonWhitelisted) : role/organizationId/permissions…', async () => {
    for (const field of [
      'role',
      'organizationId',
      'permissions',
      'invitedById',
    ]) {
      const errors = await collectErrors({
        token: 'raw-token',
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
