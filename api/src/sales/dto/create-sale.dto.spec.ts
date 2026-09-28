import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateSaleDto } from './create-sale.dto';

/** Mêmes options que la `ValidationPipe` globale (main.ts). */
async function invalidProperties(plain: Record<string, unknown>) {
  const errors = await validate(plainToInstance(CreateSaleDto, plain), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property);
}

const base = {
  productId: '112233445566778899001122',
  quantity: 1,
  salePrice: 100,
};

describe('CreateSaleDto (1-11C.1)', () => {
  it('accepte le corps historique et le corps complet', async () => {
    expect(await invalidProperties(base)).toEqual([]);
    expect(
      await invalidProperties({
        ...base,
        clientOperationId: '3b241101-e2bb-4255-8caf-4136c566a962',
        occurredAt: '2026-09-20T10:00:00.123Z',
      }),
    ).toEqual([]);
    expect(
      await invalidProperties({ ...base, occurredAt: '2026-09-20T10:00:00Z' }),
    ).toEqual([]);
  });

  it('quantity doit être un entier ≥ 1', async () => {
    expect(await invalidProperties({ ...base, quantity: 1.5 })).toContain(
      'quantity',
    );
    expect(await invalidProperties({ ...base, quantity: 0 })).toContain(
      'quantity',
    );
  });

  it.each([
    'not-a-uuid',
    '3b241101-e2bb-1255-8caf-4136c566a962', // v1
    '3b241101e2bb42558caf4136c566a962',
  ])('clientOperationId non UUID v4 refusé : %s', async (value) => {
    expect(
      await invalidProperties({ ...base, clientOperationId: value }),
    ).toContain('clientOperationId');
  });

  it.each([
    '2026-09-20T10:00:00+01:00',
    '2026-09-20T10:00:00',
    '2026-09-20',
    '2026-02-30T10:00:00Z',
    '2026-09-20 10:00:00Z',
    'yesterday',
  ])('occurredAt non ISO 8601 UTC refusé : %s', async (value) => {
    expect(await invalidProperties({ ...base, occurredAt: value })).toContain(
      'occurredAt',
    );
  });

  it.each(['organizationId', 'sellerId', 'userId', 'requestHash'])(
    'champ serveur %s refusé par la whitelist',
    async (field) => {
      expect(
        await invalidProperties({
          ...base,
          [field]: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        }),
      ).toContain(field);
    },
  );
});
