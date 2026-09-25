import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateBrandingDto } from './update-branding.dto';

function dto(fields: Record<string, unknown>): UpdateBrandingDto {
  return plainToInstance(UpdateBrandingDto, fields);
}

describe('UpdateBrandingDto (1-8A)', () => {
  it('body vide : valide (les 2 champs sont optionnels — le contrôleur exige au moins un champ OU un fichier)', async () => {
    expect(await validate(dto({}))).toHaveLength(0);
  });

  it('name/brandColor valides : aucune erreur', async () => {
    expect(
      await validate(dto({ name: 'Stock Master', brandColor: '#062B5C' })),
    ).toHaveLength(0);
  });

  it('brandColor invalide (pas #RRGGBB) → erreur', async () => {
    const errors = await validate(dto({ brandColor: 'orange' }));
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('brandColor');
  });

  it('brandColor sans # ou longueur incorrecte → erreur', async () => {
    expect(await validate(dto({ brandColor: 'FF6A00' }))).toHaveLength(1);
    expect(await validate(dto({ brandColor: '#FF6A0' }))).toHaveLength(1);
  });

  it('name trop long (>100) → erreur', async () => {
    const errors = await validate(dto({ name: 'x'.repeat(101) }));
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('name');
  });

  // slug/currency/status/logoKey/organizationId n'existent PAS sur ce DTO :
  // rejetés par le `ValidationPipe` global (`forbidNonWhitelisted`), pas ici.
  it('ne déclare aucun champ tenant/interne (whitelist implicite)', () => {
    const keys = Object.getOwnPropertyNames(new UpdateBrandingDto());
    expect(keys).not.toContain('slug');
    expect(keys).not.toContain('currency');
    expect(keys).not.toContain('status');
    expect(keys).not.toContain('logoKey');
    expect(keys).not.toContain('organizationId');
  });
});
