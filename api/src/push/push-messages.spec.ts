import * as fs from 'fs';
import * as path from 'path';
import { buildPushMessage, pushTopic } from './push-messages';
import { PushCategory } from './schemas/push-category';
import { SubscriptionPeriodKind } from '../subscriptions/subscription-terms';

const ORG = '65f000000000000000000001';
const USER = '65f000000000000000000002';
const PRODUCT = '65f000000000000000000003';
const PAYMENT = '65f000000000000000000004';
const SALE = '65f000000000000000000005';
const REPORT = '65f000000000000000000006';

describe('Messages push (1-16A)', () => {
  const subject = {
    organizationId: ORG,
    productId: PRODUCT,
    paymentId: PAYMENT,
    saleId: SALE,
    reportId: REPORT,
    periodKind: SubscriptionPeriodKind.TRIAL,
  };
  const recipient = { userId: USER, organizationId: ORG };

  it.each([
    [PushCategory.STOCK_DEPLETED, `/app/catalog/products/${PRODUCT}`],
    [PushCategory.SUBSCRIPTION_ENDING, '/app/organization/subscription'],
    [PushCategory.PAYMENT_SUCCEEDED, '/app/organization/subscription'],
    [PushCategory.STOCK_LOW, `/app/catalog/products/${PRODUCT}`],
    [PushCategory.SALE_CREATED, '/app/sales'],
    [PushCategory.SALE_DIGEST, '/app/sales'],
    [PushCategory.MONTHLY_REPORT, '/app/notifications'],
  ])(
    '%s : texte générique, lien interne, tag stable, titulaire',
    (category, url) => {
      const message = buildPushMessage({ ...subject, category }, recipient);
      expect(message.url).toBe(url);
      expect(message.url.startsWith('/app/')).toBe(true);
      expect(message.aud).toEqual({ u: USER, o: ORG });
      expect(buildPushMessage({ ...subject, category }, recipient).tag).toBe(
        message.tag,
      );
      // Rien de financier ni de métier sur l'écran verrouillé.
      const visible = `${message.title} ${message.body}`;
      expect(visible).not.toMatch(/\d/);
      expect(visible).not.toMatch(/XAF|EUR|FCFA|€/);
      expect(visible).not.toContain(PRODUCT);
    },
  );

  it('rappel : essai ou abonnement', () => {
    expect(
      buildPushMessage(
        { ...subject, category: PushCategory.SUBSCRIPTION_ENDING },
        recipient,
      ).body,
    ).toContain("d'essai");
    expect(
      buildPushMessage(
        {
          ...subject,
          periodKind: SubscriptionPeriodKind.SUBSCRIPTION,
          category: PushCategory.SUBSCRIPTION_ENDING,
        },
        recipient,
      ).body,
    ).toContain('abonnement');
  });

  it('topic RFC 8030 : 32 caractères base64url au plus, stable', () => {
    const topic = pushTopic('stock-depleted:abc');
    expect(topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(pushTopic('stock-depleted:abc')).toBe(topic);
    expect(pushTopic('stock-depleted:abd')).not.toBe(topic);
  });
});

describe('Activation réservée au démarrage HTTP (1-16A)', () => {
  const SRC = path.join(__dirname, '..');

  function sources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sources(full);
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
        ? [full]
        : [];
    });
  }

  it('`startNotifications`, `activate*` et `start` ne sont appelés que par main.ts', () => {
    const callers = sources(SRC)
      .filter((file) => !file.includes(`${path.sep}push${path.sep}`))
      .filter((file) =>
        /startNotifications\(|\.activate(Center)?\(|PushDispatcherService\)\.start\(/.test(
          fs.readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => path.relative(SRC, file));
    expect(callers).toEqual(['main.ts']);
  });

  it('aucun fournisseur push ne s’initialise au chargement du module', () => {
    for (const file of [
      ...sources(path.join(SRC, 'push')),
      ...sources(path.join(SRC, 'notifications')),
    ]) {
      const code = fs.readFileSync(file, 'utf8');
      expect(code).not.toMatch(
        /implements[^{]*(OnModuleInit|OnApplicationBootstrap)|setInterval\(/,
      );
    }
  });
});
