import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import sharp from 'sharp';
import { configureSharpSecurityPolicy } from '../common/image/sharp-security-policy';
import {
  PRODUCT_IMAGE_MAX_BYTES,
  validateProductImage,
} from './product-image-validation';

/**
 * Photos produit (R2) : contrôle RÉEL du contenu par Sharp, jamais le seul
 * MIME déclaré. Images générées par Sharp (aucun fichier externe).
 */
const solid = (width: number, height: number) =>
  sharp({
    create: { width, height, channels: 3, background: '#2a9d8f' },
  });

const file = (buffer: Buffer, mimetype: string) => ({
  buffer,
  mimetype,
  size: buffer.length,
});

async function rejection(promise: Promise<unknown>) {
  const err = (await promise.catch((e: unknown) => e)) as {
    getResponse(): { code: string; message: string };
  };
  return { err, body: err.getResponse() };
}

describe('validateProductImage', () => {
  let jpeg: Buffer;
  let png: Buffer;
  let webp: Buffer;

  beforeAll(async () => {
    configureSharpSecurityPolicy();
    jpeg = await solid(64, 48).jpeg().toBuffer();
    png = await solid(64, 48).png().toBuffer();
    webp = await solid(64, 48).webp().toBuffer();
  });

  it.each([
    ['JPEG', () => jpeg, 'image/jpeg', 'jpg'],
    ['PNG', () => png, 'image/png', 'png'],
    ['WebP', () => webp, 'image/webp', 'webp'],
  ])(
    '%s valide : format, extension et ContentType canoniques côté serveur',
    async (_l, buf, mime, ext) => {
      await expect(validateProductImage(file(buf(), mime))).resolves.toEqual({
        format: mime.slice(6),
        extension: ext,
        contentType: mime,
      });
    },
  );

  it('MIME déclaré en majuscules accepté (contrôle sur le contenu)', async () => {
    await expect(
      validateProductImage(file(jpeg, 'IMAGE/JPEG')),
    ).resolves.toMatchObject({ format: 'jpeg' });
  });

  it.each([
    [
      'SVG déguisé en PNG',
      Buffer.from('<svg onload="alert(1)"></svg>'),
      'image/png',
      'PRODUCT_IMAGE_INVALID_FILE',
    ],
    [
      'HTML déguisé en JPEG',
      Buffer.from('<html><script>x</script>'),
      'image/jpeg',
      'PRODUCT_IMAGE_INVALID_FILE',
    ],
    [
      'GIF déclaré GIF',
      Buffer.from('GIF89a......'),
      'image/gif',
      'PRODUCT_IMAGE_INVALID_FORMAT',
    ],
    [
      'HEIC déclaré',
      Buffer.from('....ftypheic'),
      'image/heic',
      'PRODUCT_IMAGE_INVALID_FORMAT',
    ],
    [
      'SVG déclaré',
      Buffer.from('<svg/>'),
      'image/svg+xml',
      'PRODUCT_IMAGE_INVALID_FORMAT',
    ],
    [
      'fichier vide',
      Buffer.alloc(0),
      'image/png',
      'PRODUCT_IMAGE_INVALID_FILE',
    ],
  ])('%s → 400 %s', async (_l, buffer, mime, code) => {
    const { err, body } = await rejection(
      validateProductImage(file(buffer, mime)),
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect(body.code).toBe(code);
  });

  it('contenu PNG déclaré JPEG (incohérent) → PRODUCT_IMAGE_INVALID_FORMAT', async () => {
    const { body } = await rejection(
      validateProductImage(file(png, 'image/jpeg')),
    );
    expect(body.code).toBe('PRODUCT_IMAGE_INVALID_FORMAT');
  });

  it('JPEG tronqué (en-tête valide, données corrompues) → PRODUCT_IMAGE_INVALID_FILE', async () => {
    const big = await solid(256, 256).jpeg({ quality: 90 }).toBuffer();
    const { body } = await rejection(
      validateProductImage(file(big.subarray(0, big.length / 2), 'image/jpeg')),
    );
    expect(body.code).toBe('PRODUCT_IMAGE_INVALID_FILE');
  });

  it('au-delà de 5 Mo → 413 PRODUCT_IMAGE_TOO_LARGE, avant tout décodage', async () => {
    const huge = Buffer.concat([jpeg, Buffer.alloc(PRODUCT_IMAGE_MAX_BYTES)]);
    const { err, body } = await rejection(
      validateProductImage(file(huge, 'image/jpeg')),
    );
    expect(err).toBeInstanceOf(PayloadTooLargeException);
    expect(body.code).toBe('PRODUCT_IMAGE_TOO_LARGE');
  });

  it('côté > 6000 px → PRODUCT_IMAGE_INVALID_DIMENSIONS', async () => {
    const wide = await solid(6001, 2).png().toBuffer();
    const { body } = await rejection(
      validateProductImage(file(wide, 'image/png')),
    );
    expect(body.code).toBe('PRODUCT_IMAGE_INVALID_DIMENSIONS');
  });

  it('surface > 24 mégapixels (côtés ≤ 6000) → PRODUCT_IMAGE_INVALID_DIMENSIONS', async () => {
    const square = await solid(5000, 5000)
      .png({ compressionLevel: 9 })
      .toBuffer();
    const { body } = await rejection(
      validateProductImage(file(square, 'image/png')),
    );
    expect(body.code).toBe('PRODUCT_IMAGE_INVALID_DIMENSIONS');
  });

  it('WebP animé → PRODUCT_IMAGE_INVALID_FILE', async () => {
    const frame = (color: string) =>
      sharp({
        create: { width: 8, height: 8, channels: 4, background: color },
      })
        .png()
        .toBuffer();
    const animated = await sharp([await frame('#f00'), await frame('#00f')], {
      join: { animated: true },
    })
      .webp({ loop: 0 })
      .toBuffer();
    const { body } = await rejection(
      validateProductImage(file(animated, 'image/webp')),
    );
    expect(body.code).toBe('PRODUCT_IMAGE_INVALID_FILE');
  });
});
