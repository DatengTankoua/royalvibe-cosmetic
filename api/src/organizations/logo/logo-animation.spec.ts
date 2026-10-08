import { crc32 } from 'zlib';
import sharp from 'sharp';
import { LOGO_NOT_STATIC_MESSAGE, validateLogoFile } from './logo-validation';
import { configureSharpSecurityPolicy } from '../../common/image/sharp-security-policy';

/**
 * 1-12D — logos STATIQUES uniquement. Fixtures réelles générées en mémoire :
 * WebP animé via l'API documentée de Sharp (`join.animated`), APNG assemblé
 * à partir de vraies images PNG (chunks `acTL`/`fcTL`/`fdAT` de la
 * spécification APNG, CRC calculés) — ce constructeur sert UNIQUEMENT aux
 * tests, jamais à la validation.
 */

const frame = (color: string) =>
  sharp({
    create: { width: 16, height: 16, channels: 4, background: color },
  })
    .png()
    .toBuffer();

const file = (buffer: Buffer, originalname: string, mimetype: string) => ({
  buffer,
  originalname,
  mimetype,
  size: buffer.length,
});

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function readChunks(png: Buffer): Array<[string, Buffer]> {
  const out: Array<[string, Buffer]> = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    out.push([
      png.toString('latin1', offset + 4, offset + 8),
      png.subarray(offset + 8, offset + 8 + length),
    ]);
    offset += 12 + length;
  }
  return out;
}

function writeChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

const u32 = (...values: number[]) => {
  const buffer = Buffer.alloc(4 * values.length);
  values.forEach((v, i) => buffer.writeUInt32BE(v, i * 4));
  return buffer;
};

/** APNG réel à 2 frames 16 × 16 (lu comme animé par les navigateurs). */
async function buildApng(): Promise<Buffer> {
  const a = readChunks(await frame('#ff0000'));
  const b = readChunks(await frame('#0000ff'));
  const idat = (chunks: Array<[string, Buffer]>) =>
    Buffer.concat(chunks.filter(([t]) => t === 'IDAT').map(([, d]) => d));
  const fctl = (sequence: number) =>
    Buffer.concat([
      u32(sequence, 16, 16, 0, 0),
      Buffer.from([0, 10, 0, 100, 0, 0]),
    ]);
  return Buffer.concat([
    PNG_SIGNATURE,
    writeChunk('IHDR', a.find(([t]) => t === 'IHDR')![1]),
    writeChunk('acTL', u32(2, 0)),
    writeChunk('fcTL', fctl(0)),
    writeChunk('IDAT', idat(a)),
    writeChunk('fcTL', fctl(1)),
    writeChunk('fdAT', Buffer.concat([u32(2), idat(b)])),
    writeChunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('validateLogoFile — logos statiques uniquement (1-12D)', () => {
  let animatedWebp: Buffer;

  beforeAll(async () => {
    configureSharpSecurityPolicy();
    animatedWebp = await sharp(
      [await frame('#ff0000'), await frame('#0000ff')],
      {
        join: { animated: true },
      },
    )
      .webp({ loop: 0 })
      .toBuffer();
  });

  it('fixture : le WebP est réellement animé (2 pages selon Sharp)', async () => {
    expect((await sharp(animatedWebp).metadata()).pages).toBe(2);
  });

  it('WebP animé → 400 LOGO_INVALID_FILE, message « statique »', async () => {
    await expect(
      validateLogoFile(file(animatedWebp, 'logo.webp', 'image/webp')),
    ).rejects.toMatchObject({
      status: 400,
      response: {
        code: 'LOGO_INVALID_FILE',
        message: LOGO_NOT_STATIC_MESSAGE,
      },
    });
  });

  it('WebP et PNG statiques → toujours acceptés', async () => {
    const png = await frame('#062b5c');
    const webp = await sharp(png).webp().toBuffer();
    await expect(
      validateLogoFile(file(png, 'logo.png', 'image/png')),
    ).resolves.toMatchObject({ format: 'png' });
    await expect(
      validateLogoFile(file(webp, 'logo.webp', 'image/webp')),
    ).resolves.toMatchObject({ format: 'webp' });
  });

  it('CARACTÉRISATION — limite ACCEPTÉE en 1-12D : libvips 8.18 n’expose PAS l’animation APNG, qui n’est donc PAS refusée (aucun parseur maison)', async () => {
    const apng = await buildApng();
    expect(apng.includes(Buffer.from('acTL'))).toBe(true);
    const metadata = await sharp(apng).metadata();
    // Si une future version de Sharp/libvips expose `pages` pour l'APNG, ce
    // test échouera : le refus par métadonnées couvrira alors l'APNG.
    expect(metadata.pages).toBeUndefined();
    await expect(
      validateLogoFile(file(apng, 'logo.png', 'image/png')),
    ).resolves.toMatchObject({ format: 'png' });
  });
});
