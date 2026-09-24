import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateSaleDto } from '../../sales/dto/create-sale.dto';
import { CreateProductDto } from '../../products/dto/create-product.dto';
import { CreateSectionDto } from '../../sections/dto/create-section.dto';
import { LoginDto } from './login.dto';
import { RegisterDto } from './register.dto';
import { SwitchOrganizationDto } from './switch-organization.dto';

async function collectErrors(
  plain: Record<string, unknown>,
  dto: new () => object,
) {
  const obj = plainToInstance(dto, plain, {
    enableImplicitConversion: true,
  });
  const errors = await validate(obj, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors;
}

describe('DTO validation (same ValidationPipe options as production)', () => {
  describe('RegisterDto', () => {
    it('rejects a missing or non-email address', async () => {
      expect(
        (
          await collectErrors(
            { name: 'Ada', email: 'nope', password: 'secret1' },
            RegisterDto,
          )
        ).length,
      ).toBeGreaterThan(0);
      expect(
        (await collectErrors({ name: 'Ada', password: 'secret1' }, RegisterDto))
          .length,
      ).toBeGreaterThan(0);
    });

    it('rejects a password shorter than 6 characters', async () => {
      expect(
        (
          await collectErrors(
            { name: 'Ada', email: 'a@b.co', password: 'x1234' },
            RegisterDto,
          )
        ).length,
      ).toBeGreaterThan(0);
    });

    it('accepts a valid payload', async () => {
      expect(
        await collectErrors(
          { name: 'Ada', email: 'ada@example.com', password: 'secret1' },
          RegisterDto,
        ),
      ).toHaveLength(0);
    });

    it('rejects unknown fields (forbidNonWhitelisted => "should not exist" constraint)', async () => {
      const errors = await collectErrors(
        { name: 'Ada', email: 'a@b.co', password: 'secret1', role: 'admin' },
        RegisterDto,
      );
      // class-validator (forbidNonWhitelisted) reports this as a
      // `whitelistValidation` constraint on the offending property.
      expect(
        errors.some(
          (e) =>
            e.property === 'role' &&
            e.constraints !== undefined &&
            Object.values(e.constraints ?? {}).some(
              (c) => typeof c === 'string' && c.includes('should not exist'),
            ),
        ),
      ).toBe(true);
    });
  });

  describe('LoginDto', () => {
    it('rejects a missing email', async () => {
      expect(
        (await collectErrors({ password: 'secret1' }, LoginDto)).length,
      ).toBeGreaterThan(0);
    });

    it('rejects a password shorter than 6 characters', async () => {
      expect(
        (await collectErrors({ email: 'a@b.co', password: '123' }, LoginDto))
          .length,
      ).toBeGreaterThan(0);
    });

    it('organizationId is OPTIONAL : un login sans le champ est valide', async () => {
      const errors = await collectErrors(
        { email: 'a@b.co', password: 'secret1' },
        LoginDto,
      );
      expect(errors.length).toBe(0);
    });

    it('organizationId présent et valide (ObjectId) → pas d’erreur', async () => {
      const errors = await collectErrors(
        {
          email: 'a@b.co',
          password: 'secret1',
          organizationId: '112233445566778899001122',
        },
        LoginDto,
      );
      expect(errors).toHaveLength(0);
    });

    it('organizationId présent mais invalide → erreur sur organizationId', async () => {
      const errors = await collectErrors(
        {
          email: 'a@b.co',
          password: 'secret1',
          organizationId: 'not-an-object-id',
        },
        LoginDto,
      );
      expect(errors.some((e) => e.property === 'organizationId')).toBe(true);
    });

    it('organizationId absent (champs inconnus interdits) sans organizationId → ok ; un champ inconnu → refusé', async () => {
      const errors = await collectErrors(
        { email: 'a@b.co', password: 'secret1', userId: 'x' },
        LoginDto,
      );
      expect(errors.some((e) => e.property === 'userId')).toBe(true);
    });
  });

  describe('SwitchOrganizationDto', () => {
    it('exige un organizationId (absent → erreur)', async () => {
      const errors = await collectErrors({}, SwitchOrganizationDto);
      expect(errors.some((e) => e.property === 'organizationId')).toBe(true);
    });

    it('rejecte un organizationId invalide', async () => {
      const errors = await collectErrors(
        { organizationId: 'zzz' },
        SwitchOrganizationDto,
      );
      expect(errors.some((e) => e.property === 'organizationId')).toBe(true);
    });

    it('accepte un ObjectId valide et REFUSE tout champ supplémentaire (jamais un userId)', async () => {
      const ok = await collectErrors(
        { organizationId: '112233445566778899001122' },
        SwitchOrganizationDto,
      );
      expect(ok).toHaveLength(0);

      const withUser = await collectErrors(
        { organizationId: '112233445566778899001122', userId: '444' },
        SwitchOrganizationDto,
      );
      expect(withUser.some((e) => e.property === 'userId')).toBe(true);
    });
  });

  describe('CreateSaleDto', () => {
    it('rejects a quantity of 0 or a negative sale price', async () => {
      expect(
        (
          await collectErrors(
            {
              productId: '112233445566778899001122',
              quantity: 0,
              salePrice: 100,
            },
            CreateSaleDto,
          )
        ).length,
      ).toBeGreaterThan(0);
      expect(
        (
          await collectErrors(
            {
              productId: '112233445566778899001122',
              quantity: 1,
              salePrice: -1,
            },
            CreateSaleDto,
          )
        ).length,
      ).toBeGreaterThan(0);
    });

    it('rejects an invalid product id', async () => {
      const errors = await collectErrors(
        { productId: 'nope', quantity: 1, salePrice: 100 },
        CreateSaleDto,
      );
      expect(errors.some((e) => e.property === 'productId')).toBe(true);
    });
  });

  describe('CreateProductDto', () => {
    it('rejects missing prices or an invalid section id', async () => {
      const errors = await collectErrors(
        {
          sectionId: 'nope',
          name: 'P',
          purchasePrice: 0,
          salePrice: 0,
          initialQuantity: 1,
        },
        CreateProductDto,
      );
      expect(
        (
          await collectErrors(
            { name: 'P', purchasePrice: 0, salePrice: 0, initialQuantity: 1 },
            CreateProductDto,
          )
        ).length,
      ).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'sectionId')).toBe(true);
    });

    it('rejects a quantity of 0', async () => {
      expect(
        (
          await collectErrors(
            {
              sectionId: '112233445566778899001122',
              name: 'P',
              purchasePrice: 100,
              salePrice: 200,
              initialQuantity: 0,
            },
            CreateProductDto,
          )
        ).length,
      ).toBeGreaterThan(0);
    });
  });

  describe('CreateSectionDto', () => {
    it('accepts a normal name', async () => {
      expect(
        (
          await collectErrors(
            { name: 'Parfums', description: '' },
            CreateSectionDto,
          )
        ).length,
      ).toBe(0);
    });

    it('rejects an empty name', async () => {
      const errors = await collectErrors(
        { name: '', description: '' },
        CreateSectionDto,
      );
      expect(errors.some((e) => e.property === 'name')).toBe(true);
    });

    it('rejects a whitespace-only name (sec: whitespace-only sections must be impossible)', async () => {
      const errors = await collectErrors(
        { name: '   ', description: '' },
        CreateSectionDto,
      );
      expect(errors.some((e) => e.property === 'name')).toBe(true);
    });

    it('rejects an absent name', async () => {
      const errors = await collectErrors({ description: '' }, CreateSectionDto);
      expect(errors.some((e) => e.property === 'name')).toBe(true);
    });

    it('documents surrounding-whitespace behaviour: names are NOT trimmed by the DTO; leading/trailing spaces still pass validation (the schema-level trim applies at storage time)', async () => {
      expect(
        (
          await collectErrors(
            { name: '  Parfums  ', description: '' },
            CreateSectionDto,
          )
        ).length,
      ).toBe(0);
    });
  });
});
