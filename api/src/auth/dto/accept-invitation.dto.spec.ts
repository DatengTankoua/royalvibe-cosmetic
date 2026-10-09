import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AcceptInvitationDto,
  CreateInvitationAccountDto,
} from './accept-invitation.dto';

// 1-18B : acceptation par session (`consent`) et création du compte invité
// (`name`/`password` requis), mêmes options que le `ValidationPipe`.
async function collectErrors(
  plain: Record<string, unknown>,
  cls: new () => object = CreateInvitationAccountDto,
) {
  const obj = plainToInstance(cls, plain);
  return validate(obj, { whitelist: true, forbidNonWhitelisted: true });
}

describe('AcceptInvitationDto / CreateInvitationAccountDto (mêmes options ValidationPipe que la production)', () => {
  it('acceptation : { token, consent: true } seul', async () => {
    expect(
      await collectErrors(
        { token: 'raw-token', consent: true },
        AcceptInvitationDto,
      ),
    ).toHaveLength(0);
    expect(
      (await collectErrors({ token: 'raw-token' }, AcceptInvitationDto)).some(
        (e) => e.property === 'consent',
      ),
    ).toBe(true);
  });

  it('création : { token, name, password } ; name et password requis', async () => {
    expect(
      await collectErrors({
        token: 'raw-token',
        name: 'Ada',
        password: 'secret-123',
      }),
    ).toHaveLength(0);
    const missing = await collectErrors({ token: 'raw-token' });
    expect(missing.map((e) => e.property).sort()).toEqual(['name', 'password']);
  });

  it('rejette un token absent ou vide', async () => {
    expect((await collectErrors({})).length).toBeGreaterThan(0);
    expect((await collectErrors({ token: '' })).length).toBeGreaterThan(0);
  });

  it('rejette un password trop court (< 6)', async () => {
    const errors = await collectErrors({
      token: 'raw-token',
      name: 'Ada',
      password: 'x1234',
    });
    expect(errors.some((e) => e.property === 'password')).toBe(true);
  });

  it('rejette un name vide', async () => {
    const errors = await collectErrors({
      token: 'raw-token',
      name: '',
      password: 'secret-123',
    });
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
        name: 'Ada',
        password: 'secret-123',
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
