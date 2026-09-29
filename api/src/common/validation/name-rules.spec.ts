import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { RegisterDto } from '../../auth/dto/register.dto';
import { AcceptInvitationDto } from '../../auth/dto/accept-invitation.dto';
import { UpdateBrandingDto } from '../../organizations/dto/update-branding.dto';
import {
  ORGANIZATION_NAME_MAX_LENGTH,
  USER_NAME_MAX_LENGTH,
} from './name-rules';

/**
 * 1-12C — mêmes règles de nom sur TOUS les DTO d'écriture, avec les
 * options du `ValidationPipe` de production (whitelist stricte).
 */
async function check<T extends object>(
  cls: new () => T,
  plain: Record<string, unknown>,
): Promise<{ instance: T; errors: string[] }> {
  const instance = plainToInstance(cls, plain);
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { instance, errors: errors.map((e) => e.property) };
}

const register = (fields: Record<string, unknown>) =>
  check(RegisterDto, {
    name: 'Awa',
    email: 'awa@example.com',
    password: 'secret1',
    organizationName: 'Boutique',
    ...fields,
  });

describe('Limites de noms (1-12C)', () => {
  it('constantes : organisation 60, utilisateur 80', () => {
    expect(ORGANIZATION_NAME_MAX_LENGTH).toBe(60);
    expect(USER_NAME_MAX_LENGTH).toBe(80);
  });

  describe('organisation — register.organizationName et branding.name', () => {
    it('60 caractères → accepté ; 61 → refusé', async () => {
      expect(
        (await register({ organizationName: 'o'.repeat(60) })).errors,
      ).toEqual([]);
      expect(
        (await register({ organizationName: 'o'.repeat(61) })).errors,
      ).toEqual(['organizationName']);
      expect(
        (await check(UpdateBrandingDto, { name: 'o'.repeat(60) })).errors,
      ).toEqual([]);
      expect(
        (await check(UpdateBrandingDto, { name: 'o'.repeat(61) })).errors,
      ).toEqual(['name']);
    });

    it('trim avant validation ET valeur trimée transmise (persistée)', async () => {
      const r = await register({ organizationName: `  ${'o'.repeat(60)}  ` });
      expect(r.errors).toEqual([]);
      expect(r.instance.organizationName).toBe('o'.repeat(60));
      const b = await check(UpdateBrandingDto, {
        name: '  Épicerie du Coin  ',
      });
      expect(b.errors).toEqual([]);
      expect(b.instance.name).toBe('Épicerie du Coin');
    });

    it('espaces seuls → refusés', async () => {
      expect((await register({ organizationName: '   \t ' })).errors).toEqual([
        'organizationName',
      ]);
      expect((await check(UpdateBrandingDto, { name: '    ' })).errors).toEqual(
        ['name'],
      );
    });

    it('Unicode et accents acceptés', async () => {
      for (const name of [
        'Épicerie Ñandú',
        'Boutique 李小龙',
        'Çà & là — №1',
      ]) {
        expect((await register({ organizationName: name })).errors).toEqual([]);
        expect((await check(UpdateBrandingDto, { name })).errors).toEqual([]);
      }
    });

    it('message simple', async () => {
      const errors = await validate(
        plainToInstance(UpdateBrandingDto, { name: 'o'.repeat(61) }),
      );
      expect(Object.values(errors[0].constraints ?? {})).toContain(
        "Le nom de l'organisation doit contenir entre 1 et 60 caractères.",
      );
    });
  });

  describe('utilisateur — register.name et acceptInvitation.name', () => {
    it('80 caractères → accepté ; 81 → refusé', async () => {
      expect((await register({ name: 'u'.repeat(80) })).errors).toEqual([]);
      expect((await register({ name: 'u'.repeat(81) })).errors).toEqual([
        'name',
      ]);
      expect(
        (
          await check(AcceptInvitationDto, {
            token: 't',
            name: 'u'.repeat(80),
            password: 'secret1',
          })
        ).errors,
      ).toEqual([]);
      expect(
        (
          await check(AcceptInvitationDto, {
            token: 't',
            name: 'u'.repeat(81),
            password: 'secret1',
          })
        ).errors,
      ).toEqual(['name']);
    });

    it('trim persistant, espaces seuls refusés', async () => {
      const r = await register({ name: '  Jean Pierre  ' });
      expect(r.errors).toEqual([]);
      expect(r.instance.name).toBe('Jean Pierre');
      expect((await register({ name: '   ' })).errors).toEqual(['name']);
      const a = await check(AcceptInvitationDto, {
        token: 't',
        name: '  Zoé  ',
        password: 'secret1',
      });
      expect(a.instance.name).toBe('Zoé');
      expect(
        (
          await check(AcceptInvitationDto, {
            token: 't',
            name: '  ',
            password: 'secret1',
          })
        ).errors,
      ).toEqual(['name']);
    });

    it('Unicode/accents acceptés ; name absent reste optionnel à l’acceptation', async () => {
      expect(
        (await register({ name: 'Anne-Sophie Élisabeth Oyono' })).errors,
      ).toEqual([]);
      expect((await check(AcceptInvitationDto, { token: 't' })).errors).toEqual(
        [],
      );
    });

    it('valeur non chaîne → refusée (jamais convertie)', async () => {
      expect((await register({ name: 42 })).errors).toEqual(['name']);
    });
  });

  it('whitelist stricte toujours active (champ inconnu → refus)', async () => {
    expect((await register({ slug: 'x' })).errors).toEqual(['slug']);
    expect(
      (await check(UpdateBrandingDto, { name: 'A', logoKey: 'x' })).errors,
    ).toEqual(['logoKey']);
  });
});
