import { readFileSync } from 'fs';
import { join } from 'path';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { RegisterDto } from '../../auth/dto/register.dto';
import { AcceptInvitationDto } from '../../auth/dto/accept-invitation.dto';
import { UpdateBrandingDto } from '../../organizations/dto/update-branding.dto';
import {
  ORGANIZATION_NAME_MAX_LENGTH,
  ORGANIZATION_NAME_MESSAGE,
  USER_NAME_MAX_LENGTH,
  USER_NAME_MESSAGE,
} from './name-rules';

/**
 * 1-12C/1-12D — mêmes règles de nom (20/20) sur TOUS les DTO d'écriture,
 * avec les options du `ValidationPipe` de production (whitelist stricte).
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
const accept = (name: unknown) =>
  check(AcceptInvitationDto, { token: 't', name, password: 'secret1' });
const branding = (name: unknown) => check(UpdateBrandingDto, { name });

describe('Limites de noms (1-12D : 20/20)', () => {
  it('constantes : organisation 20, utilisateur 20', () => {
    expect(ORGANIZATION_NAME_MAX_LENGTH).toBe(20);
    expect(USER_NAME_MAX_LENGTH).toBe(20);
  });

  it('cohérence frontend/backend : web/src/lib/name-limits.ts porte les mêmes valeurs', () => {
    const web = readFileSync(
      join(__dirname, '../../../../web/src/lib/name-limits.ts'),
      'utf8',
    );
    const read = (name: string) =>
      Number(
        new RegExp(`export const ${name} = (\\d+);`).exec(web)?.[1] ?? NaN,
      );
    expect(read('ORGANIZATION_NAME_MAX_LENGTH')).toBe(
      ORGANIZATION_NAME_MAX_LENGTH,
    );
    expect(read('USER_NAME_MAX_LENGTH')).toBe(USER_NAME_MAX_LENGTH);
  });

  describe('organisation — register.organizationName et branding.name', () => {
    it('20 caractères → accepté ; 21 → refusé', async () => {
      expect(
        (await register({ organizationName: 'o'.repeat(20) })).errors,
      ).toEqual([]);
      expect(
        (await register({ organizationName: 'o'.repeat(21) })).errors,
      ).toEqual(['organizationName']);
      expect((await branding('o'.repeat(20))).errors).toEqual([]);
      expect((await branding('o'.repeat(21))).errors).toEqual(['name']);
    });

    it('trim AVANT le calcul de longueur, valeur trimée transmise (persistée)', async () => {
      const raw = `  ${'o'.repeat(20)}  `; // 24 caractères bruts, 20 après trim
      const r = await register({ organizationName: raw });
      expect(r.errors).toEqual([]);
      expect(r.instance.organizationName).toBe('o'.repeat(20));
      const b = await branding('  Épicerie du Coin  ');
      expect(b.errors).toEqual([]);
      expect(b.instance.name).toBe('Épicerie du Coin');
    });

    it('espaces seuls → refusés', async () => {
      expect((await register({ organizationName: '   \t ' })).errors).toEqual([
        'organizationName',
      ]);
      expect((await branding('    ')).errors).toEqual(['name']);
    });

    it('Unicode et accents acceptés, comptés en caractères', async () => {
      for (const name of [
        'Épicerie Ñandú',
        'Boutique 李小龙',
        'Çà & là — №1',
        'é'.repeat(20),
      ]) {
        expect((await register({ organizationName: name })).errors).toEqual([]);
        expect((await branding(name)).errors).toEqual([]);
      }
      expect((await branding('é'.repeat(21))).errors).toEqual(['name']);
    });

    it('message simple', async () => {
      const errors = await validate(
        plainToInstance(UpdateBrandingDto, { name: 'o'.repeat(21) }),
      );
      expect(Object.values(errors[0].constraints ?? {})).toContain(
        ORGANIZATION_NAME_MESSAGE,
      );
      expect(ORGANIZATION_NAME_MESSAGE).toBe(
        "Le nom de l'organisation doit contenir entre 1 et 20 caractères.",
      );
    });
  });

  describe('utilisateur — register.name et acceptInvitation.name', () => {
    it('20 caractères → accepté ; 21 → refusé', async () => {
      expect((await register({ name: 'u'.repeat(20) })).errors).toEqual([]);
      expect((await register({ name: 'u'.repeat(21) })).errors).toEqual([
        'name',
      ]);
      expect((await accept('u'.repeat(20))).errors).toEqual([]);
      expect((await accept('u'.repeat(21))).errors).toEqual(['name']);
      expect(USER_NAME_MESSAGE).toBe(
        'Le nom doit contenir entre 1 et 20 caractères.',
      );
    });

    it('trim avant longueur, trim persistant, espaces seuls refusés', async () => {
      const r = await register({ name: `   ${'u'.repeat(20)}   ` });
      expect(r.errors).toEqual([]);
      expect(r.instance.name).toBe('u'.repeat(20));
      expect((await register({ name: '   ' })).errors).toEqual(['name']);
      const a = await accept('  Zoé  ');
      expect(a.instance.name).toBe('Zoé');
      expect((await accept('  ')).errors).toEqual(['name']);
    });

    it('Unicode/accents acceptés ; name absent reste optionnel à l’acceptation', async () => {
      expect((await register({ name: 'Anne-Sophie Oyono' })).errors).toEqual(
        [],
      );
      expect((await accept('李小龙 Ñandú')).errors).toEqual([]);
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
