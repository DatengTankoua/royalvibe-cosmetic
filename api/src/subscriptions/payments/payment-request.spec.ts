import 'reflect-metadata';
import { Types } from 'mongoose';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  computePaymentRequestFingerprint,
  derivePaymentFingerprintKey,
  maskPayerPhone,
  merchantReferenceFor,
  normalizePayerPhone,
  paymentGrantReference,
} from './payment-request';
import {
  CreateSubscriptionPaymentDto,
  ListSubscriptionPaymentsQueryDto,
} from './dto/subscription-payment.dto';
import {
  PaymentProviderUnavailableError,
  UnavailablePaymentProvider,
} from './payment-provider';
import { SubscriptionTerm } from '../subscription-terms';

describe('Téléphone du payeur (1-14D.2B)', () => {
  it.each([
    ['677123456', '237677123456'],
    ['237677123456', '237677123456'],
    ['+237 677 12 34 56', '237677123456'],
    ['00237-677.12.34.56', '237677123456'],
    [' (+237) 699 999 999 ', '237699999999'],
  ])('%p → %p', (input, expected) => {
    expect(normalizePayerPhone(input)).toBe(expected);
  });

  it.each([
    '',
    '577123456', // fixe / non mobile
    '67712345', // trop court
    '6771234567', // trop long
    '+33612345678',
    '237 6771234567',
    '6771234a6',
    '++237677123456',
    'x'.repeat(40),
    677123456,
    null,
    undefined,
  ])('refusé : %p', (input) => {
    expect(normalizePayerPhone(input)).toBeNull();
  });

  it('masquage : premier chiffre national et deux derniers seulement', () => {
    const masked = maskPayerPhone('237677123456');
    expect(masked).toBe('+237 6•• ••• •56');
    expect(masked).not.toContain('771234');
  });
});

describe('Empreinte de la demande (HMAC)', () => {
  const key = derivePaymentFingerprintKey('server-secret-a');
  const base = {
    requestedBy: '64b7f0a1c2d3e4f5a6b7c8d9',
    term: SubscriptionTerm.MONTHLY,
    payerPhone: '237677123456',
  };

  it('déterministe ; dépend du demandeur, de la durée, du téléphone et de la clé', () => {
    const fp = computePaymentRequestFingerprint(key, base);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(computePaymentRequestFingerprint(key, { ...base })).toBe(fp);
    for (const variant of [
      { ...base, requestedBy: '64b7f0a1c2d3e4f5a6b7c8da' },
      { ...base, term: SubscriptionTerm.ANNUAL },
      { ...base, payerPhone: '237677123457' },
    ]) {
      expect(computePaymentRequestFingerprint(key, variant)).not.toBe(fp);
    }
    expect(
      computePaymentRequestFingerprint(
        derivePaymentFingerprintKey('server-secret-b'),
        base,
      ),
    ).not.toBe(fp);
  });

  it('ne contient jamais le numéro ; secret requis', () => {
    expect(computePaymentRequestFingerprint(key, base)).not.toContain(
      '677123456',
    );
    expect(() => derivePaymentFingerprintKey('')).toThrow();
  });
});

describe('Références', () => {
  it('référence marchand dérivée de l’id, 26 caractères ; référence d’attribution', () => {
    const id = new Types.ObjectId('64b7f0a1c2d3e4f5a6b7c8d9');
    expect(merchantReferenceFor(id)).toBe('SM64B7F0A1C2D3E4F5A6B7C8D9');
    expect(merchantReferenceFor(id)).toHaveLength(26);
    expect(paymentGrantReference(id)).toBe('payment:64b7f0a1c2d3e4f5a6b7c8d9');
  });
});

describe('DTO de création : champs stricts', () => {
  const valid = {
    term: 'monthly',
    payerPhone: '677123456',
    clientOperationId: '3b241101-e2bb-4255-8caf-4136c566a962',
  };
  const errorsOf = async (body: Record<string, unknown>) =>
    (
      await validate(plainToInstance(CreateSubscriptionPaymentDto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      })
    ).map((e) => e.property);

  it('valide', async () => {
    expect(await errorsOf(valid)).toEqual([]);
  });

  it.each([
    ['amount', 1],
    ['currency', 'XAF'],
    ['organizationId', '64b7f0a1c2d3e4f5a6b7c8d9'],
    ['requestedBy', '64b7f0a1c2d3e4f5a6b7c8d9'],
    ['provider', 'simulated'],
    ['status', 'succeeded'],
  ])('champ forgé %s refusé', async (field, value) => {
    expect(await errorsOf({ ...valid, [field]: value })).toContain(field);
  });

  it.each([
    ['term', 'weekly'],
    ['term', 3000],
    ['clientOperationId', 'not-a-uuid'],
    ['clientOperationId', '3b241101-e2bb-1255-8caf-4136c566a962'], // v1
    ['payerPhone', 677123456],
    ['payerPhone', 'x'.repeat(33)],
  ])('%s invalide (%p)', async (field, value) => {
    expect(await errorsOf({ ...valid, [field]: value })).toContain(field);
  });

  it('historique : limite bornée 1..50, curseur ObjectId', async () => {
    const q = async (query: Record<string, unknown>) =>
      (
        await validate(plainToInstance(ListSubscriptionPaymentsQueryDto, query))
      ).map((e) => e.property);
    expect(
      await q({ limit: '20', before: '64b7f0a1c2d3e4f5a6b7c8d9' }),
    ).toEqual([]);
    expect(await q({ limit: '0' })).toEqual(['limit']);
    expect(await q({ limit: '51' })).toEqual(['limit']);
    expect(await q({ before: 'nope' })).toEqual(['before']);
  });
});

describe('Fournisseur par défaut (production)', () => {
  it('indisponible, sans aucune capacité ; ses méthodes échouent sans effet', async () => {
    const provider = new UnavailablePaymentProvider();
    expect(provider.available).toBe(false);
    expect(provider.supportsMerchantReferenceLookup).toBe(false);
    expect(provider.idempotentInitiation).toBe(false);
    await expect(provider.initiate()).rejects.toBeInstanceOf(
      PaymentProviderUnavailableError,
    );
    await expect(provider.fetchStatus()).rejects.toBeInstanceOf(
      PaymentProviderUnavailableError,
    );
  });
});
