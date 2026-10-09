import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  AcceptInvitationDto,
  InvitationTokenDto,
} from '../auth/dto/accept-invitation.dto';
import { buildInvitationAccountEmail } from './invitation-account-email';
import {
  INVITATION_ACCOUNT_PATH,
  INVITATION_ACCEPT_PATH,
  buildInvitationAccountUrl,
} from './invitation-link';

/** Options du `ValidationPipe` de production (whitelist stricte). */
async function errorsOf<T extends object>(
  cls: new () => T,
  plain: Record<string, unknown>,
): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, plain), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property).sort();
}

describe('1-18B — acceptation des invitations', () => {
  describe('AcceptInvitationDto : accord explicite, aucune donnée de compte', () => {
    it('`consent: true` exact requis', async () => {
      expect(
        await errorsOf(AcceptInvitationDto, { token: 't', consent: true }),
      ).toEqual([]);
      for (const consent of [undefined, false, 'true', 1, null]) {
        expect(
          await errorsOf(AcceptInvitationDto, { token: 't', consent }),
        ).toEqual(['consent']);
      }
    });

    it('nom, mot de passe, adresse ou acceptation légale refusés (400)', async () => {
      for (const extra of [
        { name: 'Ada' },
        { password: 'secret-123' },
        { email: 'a@b.co' },
        { userId: '112233445566778899001122' },
        { legalAcceptance: {} },
      ]) {
        const field = Object.keys(extra)[0];
        expect(
          await errorsOf(AcceptInvitationDto, {
            token: 't',
            consent: true,
            ...extra,
          }),
        ).toEqual([field]);
      }
    });

    it('token : chaîne non vide, bornée', async () => {
      expect(await errorsOf(InvitationTokenDto, { token: '' })).toEqual([
        'token',
      ]);
      expect(
        await errorsOf(InvitationTokenDto, { token: 'x'.repeat(513) }),
      ).toEqual(['token']);
      expect(await errorsOf(InvitationTokenDto, { token: 42 })).toEqual([
        'token',
      ]);
    });
  });

  describe('e-mail du lien de création', () => {
    const url = buildInvitationAccountUrl('https://app.test', 'a+b/c=');

    it('route dédiée, distincte du lien remis au créateur ; token encodé', () => {
      expect(INVITATION_ACCOUNT_PATH).not.toBe(INVITATION_ACCEPT_PATH);
      expect(url).toBe(
        `https://app.test${INVITATION_ACCOUNT_PATH}?token=${encodeURIComponent('a+b/c=')}`,
      );
    });

    it('français par défaut, anglais sur demande ; organisation échappée', () => {
      const fr = buildInvitationAccountEmail('<b>Shop</b>\nX', url);
      expect(fr.subject).toBe('Créez votre compte Stock Master');
      expect(fr.html).toContain('&lt;b&gt;Shop&lt;/b&gt; X');
      expect(fr.html).not.toContain('<b>Shop');
      expect(fr.text).toContain(url);
      expect(fr.text).not.toMatch(/Shop<\/b>\n/);

      const en = buildInvitationAccountEmail('Shop', url, 'en');
      expect(en.subject).toBe('Create your Stock Master account');
      expect(en.text).toContain(url);
      expect(en.html).toContain('lang="en"');
    });
  });
});
