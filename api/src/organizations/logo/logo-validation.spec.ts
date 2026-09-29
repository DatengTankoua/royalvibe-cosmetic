import sharp from 'sharp';
import {
  LOGO_MAX_BYTES,
  LOGO_MAX_DIMENSION,
  validateLogoFile,
} from './logo-validation';

/**
 * 1-12C — contrat du logo tenant. Fixtures RÉELLES produites en mémoire par
 * Sharp (encodeurs PNG/WebP/JPEG/GIF), aucun fichier binaire versionné,
 * aucun réseau.
 */

type Fixture = { buffer: Buffer; originalname: string; mimetype: string };

const image = (width: number, height: number) =>
  sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 255, g: 106, b: 0, alpha: 1 },
    },
  });

const file = (
  buffer: Buffer,
  originalname: string,
  mimetype: string,
): Fixture & { size: number } => ({
  buffer,
  originalname,
  mimetype,
  size: buffer.length,
});

async function expectCode(input: Fixture & { size: number }, code: string) {
  await expect(validateLogoFile(input)).rejects.toMatchObject({
    response: { code },
  });
}

describe('validateLogoFile (1-12C)', () => {
  let png: Buffer;
  let webp: Buffer;

  beforeAll(async () => {
    png = await image(64, 32).png().toBuffer();
    webp = await image(64, 32).webp().toBuffer();
  });

  it('PNG valide → format png, ContentType image/png', async () => {
    await expect(
      validateLogoFile(file(png, 'logo.png', 'image/png')),
    ).resolves.toEqual({
      format: 'png',
      extension: 'png',
      contentType: 'image/png',
    });
  });

  it('WebP valide → format webp, ContentType image/webp', async () => {
    await expect(
      validateLogoFile(file(webp, 'logo.webp', 'image/webp')),
    ).resolves.toEqual({
      format: 'webp',
      extension: 'webp',
      contentType: 'image/webp',
    });
  });

  it('extension en majuscules (LOGO.PNG / Logo.WebP) → acceptée, extension canonique minuscule', async () => {
    await expect(
      validateLogoFile(file(png, 'LOGO.PNG', 'image/png')),
    ).resolves.toMatchObject({ extension: 'png' });
    await expect(
      validateLogoFile(file(webp, 'Logo.WebP', 'image/webp')),
    ).resolves.toMatchObject({ extension: 'webp' });
  });

  it('PNG renommé .webp (MIME webp) → LOGO_INVALID_FORMAT', async () => {
    await expectCode(
      file(png, 'logo.webp', 'image/webp'),
      'LOGO_INVALID_FORMAT',
    );
  });

  it('MIME falsifié (PNG déclaré image/webp, extension .png) → LOGO_INVALID_FORMAT', async () => {
    await expectCode(
      file(png, 'logo.png', 'image/webp'),
      'LOGO_INVALID_FORMAT',
    );
  });

  it('texte déclaré image/png avec extension .png → LOGO_INVALID_FILE', async () => {
    await expectCode(
      file(Buffer.from('hello, not an image'), 'logo.png', 'image/png'),
      'LOGO_INVALID_FILE',
    );
  });

  it('fichier vide → LOGO_INVALID_FILE', async () => {
    await expectCode(
      file(Buffer.alloc(0), 'logo.png', 'image/png'),
      'LOGO_INVALID_FILE',
    );
  });

  it('PNG corrompu (données IDAT altérées) → LOGO_INVALID_FILE', async () => {
    const corrupted = Buffer.from(png);
    const idat = corrupted.indexOf('IDAT');
    for (let i = idat + 4; i < idat + 20; i++) corrupted[i] ^= 0xff;
    await expectCode(
      file(corrupted, 'logo.png', 'image/png'),
      'LOGO_INVALID_FILE',
    );
  });

  it('PNG tronqué (signature et en-tête intacts) → LOGO_INVALID_FILE', async () => {
    await expectCode(
      file(png.subarray(0, png.length - 30), 'logo.png', 'image/png'),
      'LOGO_INVALID_FILE',
    );
  });

  it('WebP corrompu (RIFF/WEBP intacts, contenu altéré) → LOGO_INVALID_FILE', async () => {
    const corrupted = Buffer.from(webp);
    for (let i = 20; i < corrupted.length; i++) corrupted[i] ^= 0x5a;
    await expectCode(
      file(corrupted, 'logo.webp', 'image/webp'),
      'LOGO_INVALID_FILE',
    );
  });

  it('> 2 Mio → LOGO_TOO_LARGE (413), avant tout décodage', async () => {
    const big = Buffer.concat([png, Buffer.alloc(LOGO_MAX_BYTES)]);
    await expect(
      validateLogoFile(file(big, 'logo.png', 'image/png')),
    ).rejects.toMatchObject({
      status: 413,
      response: { code: 'LOGO_TOO_LARGE' },
    });
  });

  it('largeur 2049 → LOGO_INVALID_DIMENSIONS', async () => {
    const wide = await image(LOGO_MAX_DIMENSION + 1, 1)
      .png()
      .toBuffer();
    await expectCode(
      file(wide, 'logo.png', 'image/png'),
      'LOGO_INVALID_DIMENSIONS',
    );
  });

  it('hauteur 2049 → LOGO_INVALID_DIMENSIONS', async () => {
    const tall = await image(1, LOGO_MAX_DIMENSION + 1)
      .webp()
      .toBuffer();
    await expectCode(
      file(tall, 'logo.webp', 'image/webp'),
      'LOGO_INVALID_DIMENSIONS',
    );
  });

  it('2049 × 2049 (au-delà de la limite de pixels) → LOGO_INVALID_DIMENSIONS', async () => {
    const huge = await image(LOGO_MAX_DIMENSION + 1, LOGO_MAX_DIMENSION + 1)
      .png()
      .toBuffer();
    await expectCode(
      file(huge, 'logo.png', 'image/png'),
      'LOGO_INVALID_DIMENSIONS',
    );
  });

  it('exactement 2048 × 2048 → accepté (PNG et WebP)', async () => {
    const maxPng = await image(LOGO_MAX_DIMENSION, LOGO_MAX_DIMENSION)
      .png()
      .toBuffer();
    const maxWebp = await image(LOGO_MAX_DIMENSION, LOGO_MAX_DIMENSION)
      .webp()
      .toBuffer();
    await expect(
      validateLogoFile(file(maxPng, 'logo.png', 'image/png')),
    ).resolves.toMatchObject({ format: 'png' });
    await expect(
      validateLogoFile(file(maxWebp, 'logo.webp', 'image/webp')),
    ).resolves.toMatchObject({ format: 'webp' });
  });

  it('SVG (extension/MIME svg) → LOGO_INVALID_FORMAT ; déguisé en .png/image/png → LOGO_INVALID_FILE', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
    );
    await expectCode(
      file(svg, 'logo.svg', 'image/svg+xml'),
      'LOGO_INVALID_FORMAT',
    );
    await expectCode(file(svg, 'logo.png', 'image/png'), 'LOGO_INVALID_FILE');
  });

  it('JPEG et GIF (réels) → refusés, déclarés tels quels ou déguisés', async () => {
    const jpeg = await image(16, 16).jpeg().toBuffer();
    const gif = await image(16, 16).gif().toBuffer();
    await expectCode(
      file(jpeg, 'logo.jpg', 'image/jpeg'),
      'LOGO_INVALID_FORMAT',
    );
    await expectCode(file(gif, 'logo.gif', 'image/gif'), 'LOGO_INVALID_FORMAT');
    await expectCode(file(jpeg, 'logo.png', 'image/png'), 'LOGO_INVALID_FILE');
    await expectCode(file(gif, 'logo.webp', 'image/webp'), 'LOGO_INVALID_FILE');
  });

  it('sans extension ou nom de fichier avec chemin → seul l’extname compte, jamais le reste', async () => {
    await expectCode(file(png, 'logo', 'image/png'), 'LOGO_INVALID_FORMAT');
    await expect(
      validateLogoFile(file(png, '../../etc/passwd.png', 'image/png')),
    ).resolves.toMatchObject({ extension: 'png' });
  });

  it('messages d’erreur simples, sans détail interne (pas de stack, chemin ni octet)', async () => {
    try {
      await validateLogoFile(
        file(Buffer.from('x'.repeat(40)), 'logo.png', 'image/png'),
      );
      throw new Error('should have thrown');
    } catch (err) {
      const body = (err as { response: Record<string, unknown> }).response;
      expect(Object.keys(body).sort()).toEqual(['code', 'message']);
      expect(body.message).toBe('Fichier image vide, corrompu ou illisible.');
    }
  });

  it('chargeurs libvips non PNG/WebP bloqués (défense en profondeur)', async () => {
    const jpeg = await image(8, 8).jpeg().toBuffer();
    await expect(sharp(jpeg).metadata()).rejects.toThrow();
  });
});
