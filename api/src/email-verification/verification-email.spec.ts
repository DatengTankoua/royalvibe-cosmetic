import {
  EMAIL_VERIFICATION_PATH,
  buildEmailVerificationUrl,
  buildVerificationEmail,
  escapeHtml,
} from './verification-email';

describe('verification-email (1-13A)', () => {
  it('lien : origine configurée + /auth/verify-email + token encodé', () => {
    expect(EMAIL_VERIFICATION_PATH).toBe('/auth/verify-email');
    expect(
      buildEmailVerificationUrl('https://app.example.com', 'a+b/c=d'),
    ).toBe('https://app.example.com/auth/verify-email?token=a%2Bb%2Fc%3Dd');
  });

  it('échappe les valeurs dynamiques du HTML', () => {
    expect(escapeHtml(`<script>"'&`)).toBe('&lt;script&gt;&quot;&#39;&amp;');
    const email = buildVerificationEmail(
      '<img src=x onerror=alert(1)>',
      'https://app.example.com/auth/verify-email?token=abc&x="y"',
    );
    expect(email.html).not.toContain('<img');
    expect(email.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(email.html).toContain(
      'href="https://app.example.com/auth/verify-email?token=abc&amp;x=&quot;y&quot;"',
    );
  });

  it('français, HTML et texte, sans retour à la ligne injecté par le nom', () => {
    const email = buildVerificationEmail(
      'Ada\r\nBcc: x',
      'https://app.example.com/auth/verify-email?token=abc',
    );
    expect(email.subject).toContain('Confirmez votre adresse email');
    expect(email.html).toContain('Confirmer mon adresse email');
    expect(email.text).toContain(
      'https://app.example.com/auth/verify-email?token=abc',
    );
    expect(email.text.split('\n')[0]).toBe('Bonjour Ada Bcc: x,');
    expect(email.text).toContain('24 heures');
  });
});
