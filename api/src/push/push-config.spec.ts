import { createECDH } from 'crypto';
import { resolveWebPushConfig, WebPushConfigError } from './push-config';

/** Paire VAPID ÉPHÉMÈRE générée par le test (aucune clé réelle). */
function vapidPair() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: ecdh.getPrivateKey().toString('base64url'),
  };
}

describe('resolveWebPushConfig (1-16A)', () => {
  const pair = vapidPair();
  const enabled = {
    WEB_PUSH_ENABLED: 'true',
    WEB_PUSH_VAPID_PUBLIC_KEY: pair.publicKey,
    WEB_PUSH_VAPID_PRIVATE_KEY: pair.privateKey,
    WEB_PUSH_VAPID_SUBJECT: 'mailto:ops@example.com',
  };

  it.each([[{}], [{ WEB_PUSH_ENABLED: '' }], [{ WEB_PUSH_ENABLED: 'false' }]])(
    'désactivé par défaut, clés ignorées (%j)',
    (env) => {
      expect(
        resolveWebPushConfig({ ...env, WEB_PUSH_VAPID_PRIVATE_KEY: 'x' }),
      ).toEqual({ enabled: false });
    },
  );

  it('activé : paire valide acceptée', () => {
    expect(resolveWebPushConfig(enabled)).toEqual({
      enabled: true,
      publicKey: pair.publicKey,
      privateKey: pair.privateKey,
      subject: 'mailto:ops@example.com',
    });
    expect(
      resolveWebPushConfig({
        ...enabled,
        WEB_PUSH_VAPID_SUBJECT: 'https://stockmaster.example.com',
      }).enabled,
    ).toBe(true);
  });

  it.each([
    ['valeur de drapeau inconnue', { WEB_PUSH_ENABLED: '1' }],
    ['clé publique absente', { WEB_PUSH_VAPID_PUBLIC_KEY: '' }],
    ['clé privée absente', { WEB_PUSH_VAPID_PRIVATE_KEY: undefined }],
    ['sujet absent', { WEB_PUSH_VAPID_SUBJECT: ' ' }],
    ['clé publique non base64url', { WEB_PUSH_VAPID_PUBLIC_KEY: 'a+b/c==' }],
    [
      'clé publique tronquée',
      { WEB_PUSH_VAPID_PUBLIC_KEY: pair.publicKey.slice(0, 40) },
    ],
    [
      'clé privée de mauvaise taille',
      { WEB_PUSH_VAPID_PRIVATE_KEY: pair.privateKey.slice(0, 30) },
    ],
    ['paire incohérente', { WEB_PUSH_VAPID_PUBLIC_KEY: vapidPair().publicKey }],
    ['sujet http', { WEB_PUSH_VAPID_SUBJECT: 'http://example.com' }],
    ['sujet libre', { WEB_PUSH_VAPID_SUBJECT: 'ops@example.com' }],
  ])('activé mais invalide → erreur claire (%s)', (_label, override) => {
    let error: unknown;
    try {
      resolveWebPushConfig({ ...enabled, ...override });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(WebPushConfigError);
    // Jamais la valeur d'une clé dans le message.
    expect((error as Error).message).not.toContain(pair.privateKey);
    expect((error as Error).message).not.toContain(pair.publicKey);
  });
});
