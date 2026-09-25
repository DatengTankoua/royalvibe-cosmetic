import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

@Injectable()
export class S3Service {
  private readonly s3Client: S3Client;
  private readonly bucket: string;
  private readonly endpoint: string;
  private readonly publicUrlBase: string;
  // Origine + chemin de base RÉELLEMENT utilisés pour produire les URLs
  // (cf. `uploadFile`) : seule frontière acceptée par `deleteFile`.
  // `undefined` si la config est un URL invalide → suppressions refusées.
  private readonly publicUrlOrigin: string | undefined;
  private readonly publicUrlBasePath: string | undefined;

  constructor(private configService: ConfigService) {
    this.bucket = this.configService.get<string>('S3_BUCKET')!;
    this.endpoint = this.configService.get<string>('S3_ENDPOINT')!;
    this.publicUrlBase = (
      this.configService.get<string>('S3_PUBLIC_URL') ??
      `${this.endpoint}/${this.bucket}`
    ).replace(/\/+$/, '');

    try {
      const parsedBase = new URL(this.publicUrlBase);
      this.publicUrlOrigin = parsedBase.origin;
      this.publicUrlBasePath = `${parsedBase.pathname.replace(/\/+$/, '')}/`;
    } catch {
      this.publicUrlOrigin = undefined;
      this.publicUrlBasePath = undefined;
    }

    this.s3Client = new S3Client({
      endpoint: this.endpoint,
      region: this.configService.get<string>('S3_REGION'),
      credentials: {
        accessKeyId: this.configService.get<string>('S3_ACCESS_KEY')!,
        secretAccessKey: this.configService.get<string>('S3_SECRET_KEY')!,
      },
      forcePathStyle:
        this.configService.get<string>('S3_FORCE_PATH_STYLE') === 'true',
    });
  }

  /**
   * `keyPrefix` (ex. `organizations/<orgId>/products`) est fourni par
   * l'appelant : ce service reste agnostique du tenant, la frontière org
   * est imposée côté appelant (jamais déduite d'un DTO/nom de fichier ici).
   */
  async uploadFile(
    file: Express.Multer.File,
    keyPrefix: string,
  ): Promise<string> {
    const { url } = await this.uploadStoredFile(file, keyPrefix);
    return url;
  }

  /**
   * Variante de `uploadFile` (1-8A) retournant `{key,url}` : utile quand
   * l'appelant doit PERSISTER la clé elle-même (ex. `Organization.logoKey`)
   * plutôt que seulement l'URL publique dérivée.
   */
  async uploadStoredFile(
    file: Express.Multer.File,
    keyPrefix: string,
  ): Promise<{ key: string; url: string }> {
    const key = `${keyPrefix}/${randomUUID()}-${this.sanitizeFilename(file.originalname)}`;

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      }),
    );

    return { key, url: this.publicUrlForKey(key) };
  }

  /** URL publique déterministe pour une clé déjà connue (jamais recalculée depuis une entrée cliente). */
  publicUrlForKey(key: string): string {
    return `${this.publicUrlBase}/${key}`;
  }

  /**
   * `allowedPrefix` doit correspondre EXACTEMENT au préfixe de tenant sous
   * lequel la clé a été émise. Clé rejetée (URL étrangère/malformée/hors
   * frontière/hors préfixe) : no-op silencieux, aucun appel réseau, jamais
   * l'URL ni un secret journalisés.
   */
  async deleteFile(imageUrl: string, allowedPrefix: string): Promise<void> {
    const key = this.extractTenantKey(imageUrl);
    if (!key) return;
    await this.deleteStoredKey(key, allowedPrefix);
  }

  /**
   * Suppression par CLÉ déjà connue (1-8A, jamais une URL cliente) : utile
   * quand seule la clé est persistée (ex. `Organization.logoKey`). `key`
   * doit débuter EXACTEMENT par `allowedPrefix + '/'` (jamais un
   * `startsWith` nu sans séparateur, sinon un préfixe voisin — organisation
   * B, ou un dossier "legacy"/frère — serait accepté à tort).
   */
  async deleteStoredKey(key: string, allowedPrefix: string): Promise<void> {
    const boundedPrefix = allowedPrefix.endsWith('/')
      ? allowedPrefix
      : `${allowedPrefix}/`;
    if (!key.startsWith(boundedPrefix)) return;

    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }

  /**
   * Parse STRUCTURÉ (`new URL`, jamais un `split`/`includes` naïf) : origine
   * ET chemin de base doivent correspondre EXACTEMENT à la configuration
   * réellement utilisée pour produire les URLs (`publicUrlBase`), sinon une
   * origine étrangère portant le même nom de bucket dans son chemin
   * (`https://evil.example/<bucket>/...`) serait acceptée à tort. La
   * frontière de préfixe tenant est vérifiée séparément par
   * `deleteStoredKey` (partagée avec les clés déjà connues, jamais issues
   * d'une URL). Toute anomalie (credentials, origine/chemin voisin,
   * encodage invalide, clé plate) → `undefined`.
   */
  private extractTenantKey(imageUrl: string): string | undefined {
    if (!this.publicUrlOrigin || !this.publicUrlBasePath) return undefined;

    let parsed: URL;
    try {
      parsed = new URL(imageUrl);
    } catch {
      return undefined;
    }
    if (parsed.username || parsed.password) return undefined;
    if (parsed.origin !== this.publicUrlOrigin) return undefined;
    if (!parsed.pathname.startsWith(this.publicUrlBasePath)) return undefined;

    let key: string;
    try {
      key = decodeURIComponent(
        parsed.pathname.slice(this.publicUrlBasePath.length),
      );
    } catch {
      return undefined;
    }
    if (!key) return undefined;

    return key;
  }

  /**
   * Nom de fichier serveur : basename seul (traversal/slashes neutralisés),
   * caractères de contrôle et Unicode hors ASCII retirés, espaces en tirets ;
   * extension utile préservée et nettoyée séparément.
   */
  private sanitizeFilename(originalName: string): string {
    const base =
      originalName
        .split(/[/\\]/)
        .filter((segment) => segment.length > 0 && segment !== '..')
        .pop() ?? '';
    // eslint-disable-next-line no-control-regex -- neutralise volontairement les caractères de contrôle du nom de fichier
    const noControl = base.normalize('NFKC').replace(/[\x00-\x1f\x7f]/g, '');

    const dotIndex = noControl.lastIndexOf('.');
    const hasExtension = dotIndex > 0 && dotIndex < noControl.length - 1;
    const stem = hasExtension ? noControl.slice(0, dotIndex) : noControl;
    const rawExtension = hasExtension ? noControl.slice(dotIndex + 1) : '';

    const cleanStem =
      stem
        .replace(/\s+/g, '-')
        .replace(/[^a-zA-Z0-9._-]/g, '')
        .replace(/\.+/g, '.')
        .replace(/^[.-]+|[.-]+$/g, '') || 'file';
    const cleanExtension = rawExtension
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 10)
      .toLowerCase();

    return cleanExtension ? `${cleanStem}.${cleanExtension}` : cleanStem;
  }
}
