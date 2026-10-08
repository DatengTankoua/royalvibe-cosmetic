import { randomBytes, createECDH } from 'crypto';
import {
  isAllowedPushEndpoint,
  validatePushSubscriptionInput,
} from './push-endpoint-policy';

const keys = () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
};

describe('Politique des endpoints push (1-16A)', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc:def',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
    'https://web.push.apple.com/QGx7',
    'https://api.push.apple.com/3/device/x',
    'https://wns2-bl2p.notify.windows.com/w/?token=BQYAAA',
  ])('service push documenté accepté : %s', (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(true);
  });

  it.each([
    ['http', 'http://fcm.googleapis.com/fcm/send/x'],
    ['hôte arbitraire', 'https://attacker.example.com/push'],
    ['suffixe trompeur', 'https://fcm.googleapis.com.attacker.example/x'],
    ['suffixe sans libellé', 'https://.notify.windows.com/x'],
    ['libellé composé', 'https://a.b.notify.windows.com/x'],
    ['nom imitant', 'https://evilpush.apple.com.example/x'],
    ['IP privée', 'https://10.0.0.1/push'],
    ['localhost', 'https://localhost/push'],
    ['IPv6', 'https://[::1]/push'],
    ['port explicite', 'https://fcm.googleapis.com:8443/fcm/send/x'],
    ['identifiants', 'https://user:pw@fcm.googleapis.com/fcm/send/x'],
    ['fragment', 'https://fcm.googleapis.com/fcm/send/x#y'],
    ['trop long', `https://fcm.googleapis.com/${'a'.repeat(2100)}`],
    ['non URL', 'fcm.googleapis.com/x'],
  ])('destination refusée (%s)', (_label, endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });

  it('clés : point P-256 non compressé de 65 octets et secret de 16 octets', () => {
    const good = keys();
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
    expect(validatePushSubscriptionInput({ endpoint, keys: good })).toEqual({
      endpoint,
      ...good,
    });
    for (const bad of [
      { ...good, p256dh: good.p256dh.slice(0, 60) },
      { ...good, p256dh: Buffer.alloc(65, 1).toString('base64url') },
      { ...good, auth: randomBytes(8).toString('base64url') },
      { ...good, auth: 'not base64!' },
      { ...good, p256dh: 42 },
      null,
    ]) {
      expect(
        validatePushSubscriptionInput({
          endpoint,
          keys: bad,
        }),
      ).toBeNull();
    }
    expect(
      validatePushSubscriptionInput({
        endpoint: 'https://attacker.example.com/x',
        keys: good,
      }),
    ).toBeNull();
  });
});
