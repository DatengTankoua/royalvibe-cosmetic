import {
  localeFromAcceptLanguage,
  localeFromRequest,
  recipientLocale,
  requestedLocale,
} from './locale';
import {
  ERROR_MESSAGE_TRANSLATIONS,
  translateErrorBodyMessage,
  translateErrorMessage,
} from './error-messages';
import { scanErrorMessages } from './error-message-scan';
import { buildVerificationEmail } from '../../email-verification/verification-email';
import {
  buildPasswordChangedEmail,
  buildPasswordResetEmail,
} from '../../password-reset/password-reset-email';
import { buildPushMessage, notificationBody } from '../../push/push-messages';
import { PushCategory } from '../../push/schemas/push-category';
import { SubscriptionPeriodKind } from '../../subscriptions/subscription-terms';
import { REPORT_LABELS } from '../../reports/report-labels';
import {
  pdfUnsupportedException,
  reportFilename,
} from '../../reports/monthly-history.controller';
import { PdfUnsupportedTextError } from '../../reports/pdf/pdf-fonts';

/** Forme d'un objet de libellés : clés et types, récursivement. */
function shape(value: unknown): unknown {
  if (typeof value === 'function') return 'function';
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, shape(v)]),
    );
  }
  return typeof value;
}

describe('1-16G — langues', () => {
  describe('langue de la requête et du destinataire', () => {
    it('Accept-Language : première langue prise en charge, poids respectés', () => {
      expect(localeFromAcceptLanguage('en-US,en;q=0.9,fr;q=0.8')).toBe('en');
      expect(localeFromAcceptLanguage('de-DE,fr;q=0.5,en;q=0.4')).toBe('fr');
      expect(localeFromAcceptLanguage('de;q=1,en;q=0.2')).toBe('en');
      expect(localeFromAcceptLanguage('fr;q=0.1,en;q=0.9')).toBe('en');
      expect(localeFromAcceptLanguage('de,es')).toBe('fr');
      expect(localeFromAcceptLanguage(undefined)).toBe('fr');
      expect(localeFromAcceptLanguage('x'.repeat(600))).toBe('fr');
    });

    it('`?lang=` explicite prioritaire ; valeur inconnue ignorée', () => {
      expect(
        localeFromRequest({
          query: { lang: 'en' },
          headers: { 'accept-language': 'fr' },
        }),
      ).toBe('en');
      expect(
        localeFromRequest({
          query: { lang: 'de' },
          headers: { 'accept-language': 'en' },
        }),
      ).toBe('en');
    });

    it('sans langue demandée : aucune (messages laissés tels quels)', () => {
      expect(requestedLocale({ headers: {} })).toBeNull();
      expect(requestedLocale({ headers: { 'accept-language': 'en' } })).toBe(
        'en',
      );
    });

    it('destinataire : préférence enregistrée, sinon français', () => {
      expect(recipientLocale('en')).toBe('en');
      expect(recipientLocale(undefined)).toBe('fr');
      expect(recipientLocale('de')).toBe('fr');
    });
  });

  describe("messages d'erreur", () => {
    it('chaque message lancé dans le code a une entrée au catalogue', () => {
      const scanned = scanErrorMessages().filter(
        // Codes stables (MAJUSCULES) : jamais traduits.
        (m) => !/^[A-Z][A-Z0-9_]*$/.test(m.text),
      );
      expect(scanned.length).toBeGreaterThan(90);
      const missing = [
        ...new Set(
          scanned
            .filter((m) => !(m.text in ERROR_MESSAGE_TRANSLATIONS))
            .map((m) => `${m.text} (${m.file}:${m.line})`),
        ),
      ];
      expect(missing).toEqual([]);
    });

    it('chaque message français a une version anglaise', () => {
      const withoutEnglish = Object.entries(ERROR_MESSAGE_TRANSLATIONS)
        .filter(([source, t]) => /[À-ÿ]/.test(source) && !t.en)
        .map(([source]) => source);
      expect(withoutEnglish).toEqual([]);
    });

    it('les valeurs variables sont conservées, à leur place', () => {
      expect(translateErrorMessage('Product abc not found', 'fr')).toBe(
        'Produit abc introuvable.',
      );
      expect(
        translateErrorMessage(
          'Le nom doit contenir entre 1 et 20 caractères.',
          'en',
        ),
      ).toBe('The name must be between 1 and 20 characters.');
      expect(
        translateErrorMessage(
          "Trop de téléchargements d'historique en peu de temps. Réessayez dans 3 min.",
          'en',
        ),
      ).toBe('Too many history downloads in a short time. Try again in 3 min.');
    });

    it('message déjà dans la langue, ou inconnu : renvoyé tel quel', () => {
      expect(translateErrorMessage('Mois invalide.', 'fr')).toBe(
        'Mois invalide.',
      );
      const technical = 'Unexpected token } in JSON at position 4';
      expect(translateErrorMessage(technical, 'en')).toBe(technical);
      expect(translateErrorMessage(technical, 'fr')).toBe(technical);
    });

    it('liste de validation : chaque élément traduit', () => {
      expect(
        translateErrorBodyMessage(
          ['Mois invalide.', 'name must be a string'],
          'en',
        ),
      ).toEqual(['Invalid month.', 'name must be a string']);
    });
  });

  describe('e-mails : langue du destinataire', () => {
    it('confirmation d’adresse : anglais, valeurs échappées, même lien', () => {
      const url = 'https://app.example/auth/verify-email?token=a%26b';
      const mail = buildVerificationEmail('<Awa>', url, 'en');
      expect(mail.subject).toBe('Confirm your email address – Stock Master');
      expect(mail.html).toContain('<html lang="en">');
      expect(mail.html).toContain('Hello &lt;Awa&gt;,');
      expect(mail.html).not.toContain('<Awa>');
      expect(mail.text).toContain(url);
      expect(buildVerificationEmail('Awa', url).subject).toBe(
        'Confirmez votre adresse email – Stock Master',
      );
    });

    it('réinitialisation et changement de mot de passe', () => {
      const reset = buildPasswordResetEmail('Awa', 'https://x/r?token=t', 'en');
      expect(reset.subject).toBe('Reset your password – Stock Master');
      expect(reset.text).toContain('valid for 1 hour');
      const changed = buildPasswordChangedEmail('Awa', 'en');
      expect(changed.subject).toBe(
        'Your Stock Master password has been changed.',
      );
      expect(changed.html).not.toMatch(/token|https?:/);
      expect(buildPasswordChangedEmail('Awa').subject).toBe(
        'Votre mot de passe Stock Master a été modifié.',
      );
    });
  });

  describe('notifications : textes génériques', () => {
    const categories = Object.values(PushCategory);

    it('anglais pour chaque catégorie, toujours sans donnée métier', () => {
      for (const category of categories) {
        const fr = notificationBody(category, null, 'fr');
        const en = notificationBody(category, null, 'en');
        expect(en).toBeTruthy();
        expect(en).not.toBe(fr);
        expect(en).not.toMatch(/\d/);
      }
      expect(
        notificationBody(
          PushCategory.SUBSCRIPTION_ENDING,
          SubscriptionPeriodKind.TRIAL,
          'en',
        ),
      ).toBe('Your trial period is ending soon.');
    });

    it('push : langue du destinataire, titulaire inchangé', () => {
      const subject = {
        category: PushCategory.STOCK_DEPLETED,
        organizationId: 'o1',
        productId: 'p1',
        paymentId: null,
        periodKind: null,
      };
      const en = buildPushMessage(subject, {
        userId: 'u1',
        organizationId: 'o1',
        locale: 'en',
      });
      const fr = buildPushMessage(subject, {
        userId: 'u1',
        organizationId: 'o1',
      });
      expect(en.body).toBe('A product is out of stock.');
      expect(fr.body).toBe('Un produit est en rupture de stock.');
      expect({ ...en, body: '' }).toEqual({ ...fr, body: '' });
    });
  });

  describe('rapports mensuels', () => {
    it('libellés anglais de même forme que le français', () => {
      expect(shape(REPORT_LABELS.en)).toEqual(shape(REPORT_LABELS.fr));
      expect(REPORT_LABELS.en.currency).toBe(REPORT_LABELS.fr.currency);
    });

    it('nom de fichier et message PDF selon la langue', () => {
      expect(reportFilename('boutique-a', '2026-09', 'pdf', 'en')).toBe(
        'sales-history-boutique-a-2026-09.pdf',
      );
      expect(reportFilename('boutique-a', '2026-09', 'pdf')).toBe(
        'historique-boutique-a-2026-09.pdf',
      );
      const error = new PdfUnsupportedTextError(['😀', 'Ж']);
      const en = pdfUnsupportedException(error, 'en').getResponse() as {
        code: string;
        message: string;
      };
      expect(en.code).toBe('REPORT_PDF_UNSUPPORTED_CHARACTERS');
      expect(en.message).toContain('“😀”, “Ж”');
      expect(en.message).toContain('Download the Excel version');
    });
  });
});
