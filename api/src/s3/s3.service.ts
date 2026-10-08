import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';

/**
 * Référence DURABLE d'un objet stocké (R2) : la clé ET l'identité du
 * stockage qui l'a reçu. Jamais d'URL (publique ou signée) en base : l'URL de
 * lecture est signée à chaque réponse (`signedReadUrl`).
 *
 * `storage` = `null` pour une référence antérieure à cette identité (ancien
 * `logoKey` seul) : son stockage est inconnu, elle n'est donc ni lue ni
 * supprimée dans le stockage courant.
 */
export interface StoredObjectRef {
  key: string;
  storage: string | null;
}

/**
 * Sort du fichier remplacé ou supprimé, APRÈS l'écriture MongoDB :
 * - `deleted` : objet supprimé du stockage courant ;
 * - `not_needed` : aucun fichier précédent ;
 * - `retained` : référence d'un autre stockage (ou ancienne URL) : laissée
 *   en place, jamais supprimée à l'aveugle ;
 * - `failed` : la suppression a échoué — l'objet reste, orphelin, et
 *   l'échec est journalisé (jamais présenté comme supprimé).
 */
export type StorageCleanup = 'deleted' | 'not_needed' | 'retained' | 'failed';

/** Durée de validité par défaut d'une URL de lecture signée (15 min). */
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 900;
const MIN_SIGNED_URL_TTL_SECONDS = 60;
const MAX_SIGNED_URL_TTL_SECONDS = 3600;

type ChecksumMode = 'WHEN_SUPPORTED' | 'WHEN_REQUIRED';

export class StorageConfigError extends Error {}

/**
 * Identité d'un stockage : hôte (+ chemin éventuel) de l'endpoint et
 * bucket. Deux configurations différentes (ancien fournisseur, autre
 * compte, autre juridiction, autre bucket) ont des identités différentes.
 */
export function storageIdentity(
  endpoint: string | undefined,
  bucket: string | undefined,
): string | null {
  if (!endpoint || !bucket) return null;
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.host.toLowerCase()}${path}/${bucket.trim()}`;
}

function parseTtl(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_SIGNED_URL_TTL_SECONDS;
  }
  const ttl = Number(value);
  if (
    !Number.isInteger(ttl) ||
    ttl < MIN_SIGNED_URL_TTL_SECONDS ||
    ttl > MAX_SIGNED_URL_TTL_SECONDS
  ) {
    throw new StorageConfigError(
      `S3_SIGNED_URL_TTL_SECONDS doit être un entier entre ${MIN_SIGNED_URL_TTL_SECONDS} et ${MAX_SIGNED_URL_TTL_SECONDS}`,
    );
  }
  return ttl;
}

/**
 * Sommes de contrôle du SDK. Défaut : comportement du SDK (CRC32 à
 * l'upload, `x-amz-checksum-mode` sur les GET signés). `when_required` ne
 * doit être choisi qu'après l'essai réel R2 (procédure opérateur).
 */
function parseChecksumMode(value: string | undefined): ChecksumMode {
  if (value === undefined || value.trim() === '') return 'WHEN_SUPPORTED';
  if (value === 'when_supported') return 'WHEN_SUPPORTED';
  if (value === 'when_required') return 'WHEN_REQUIRED';
  throw new StorageConfigError(
    'S3_CHECKSUM_MODE doit valoir when_supported ou when_required',
  );
}

function isWithinPrefix(key: string, allowedPrefix: string): boolean {
  const boundedPrefix = allowedPrefix.endsWith('/')
    ? allowedPrefix
    : `${allowedPrefix}/`;
  return key.startsWith(boundedPrefix) && key.length > boundedPrefix.length;
}

@Injectable()
export class S3Service {
  private readonly logger = new Logger('Storage');
  private readonly s3Client: S3Client;
  private readonly bucket: string;
  /** Identité du stockage courant ; `null` si endpoint/bucket absents. */
  readonly storage: string | null;
  readonly signedUrlTtlSeconds: number;

  constructor(private configService: ConfigService) {
    this.bucket = this.configService.get<string>('S3_BUCKET') ?? '';
    const endpoint = this.configService.get<string>('S3_ENDPOINT');
    this.storage = storageIdentity(endpoint, this.bucket);
    this.signedUrlTtlSeconds = parseTtl(
      this.configService.get<string>('S3_SIGNED_URL_TTL_SECONDS'),
    );
    const checksum = parseChecksumMode(
      this.configService.get<string>('S3_CHECKSUM_MODE'),
    );

    this.s3Client = new S3Client({
      endpoint,
      region: this.configService.get<string>('S3_REGION'),
      credentials: {
        accessKeyId: this.configService.get<string>('S3_ACCESS_KEY') ?? '',
        secretAccessKey: this.configService.get<string>('S3_SECRET_KEY') ?? '',
      },
      forcePathStyle:
        this.configService.get<string>('S3_FORCE_PATH_STYLE') === 'true',
      requestChecksumCalculation: checksum,
      responseChecksumValidation: checksum,
    });
  }

  /**
   * Upload d'une image DÉJÀ validée côté serveur (logo 1-12C, photo produit
   * R2) : clé `${keyPrefix}/${uuid}.${extension}` sans aucun nom client, et
   * `ContentType` issu du format détecté côté serveur — jamais de
   * `originalname` ni de `mimetype` client. `keyPrefix`
   * (`organizations/<orgId>/…`) est imposé par l'appelant.
   */
  async uploadValidatedImage(
    body: Buffer,
    keyPrefix: string,
    image: { extension: string; contentType: string },
  ): Promise<StoredObjectRef> {
    if (!this.storage) throw new Error('Stockage non configuré');
    const key = `${keyPrefix}/${randomUUID()}.${image.extension}`;

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: image.contentType,
      }),
    );

    return { key, storage: this.storage };
  }

  /**
   * URL GET signée, à durée explicite, pour une référence DÉJÀ lue en base
   * dans le périmètre de l'organisation du demandeur. Jamais une clé fournie
   * par le client. `null` (aucune URL) si : pas de référence, autre
   * stockage ou stockage inconnu, clé hors du préfixe EXACT attendu, ou
   * signature impossible.
   *
   * Un lien signé reste utilisable par quiconque le détient jusqu'à son
   * expiration ; l'expiration n'efface pas les copies déjà téléchargées.
   */
  async signedReadUrl(
    ref: StoredObjectRef | null,
    allowedPrefix: string,
  ): Promise<string | null> {
    if (!ref || !this.storage || ref.storage !== this.storage) return null;
    if (!isWithinPrefix(ref.key, allowedPrefix)) return null;
    try {
      return await getSignedUrl(
        this.s3Client,
        new GetObjectCommand({ Bucket: this.bucket, Key: ref.key }),
        { expiresIn: this.signedUrlTtlSeconds },
      );
    } catch {
      this.logger.warn('Signature de lecture impossible');
      return null;
    }
  }

  /**
   * Suppression d'un objet APRÈS l'écriture MongoDB correspondante.
   * Seulement dans le stockage courant et sous le préfixe EXACT attendu
   * (`allowedPrefix + '/'`, jamais un `startsWith` nu) ; sinon l'objet est
   * laissé en place (`retained`). Un échec ne lève pas : il est renvoyé
   * (`failed`) et journalisé, l'objet restant orphelin.
   */
  async deleteStoredObject(
    ref: StoredObjectRef | null,
    allowedPrefix: string,
  ): Promise<StorageCleanup> {
    if (!ref) return 'not_needed';
    if (!this.storage || ref.storage !== this.storage) return 'retained';
    if (!isWithinPrefix(ref.key, allowedPrefix)) return 'retained';
    try {
      await this.s3Client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: ref.key }),
      );
      return 'deleted';
    } catch {
      this.logger.warn(
        `Suppression échouée, objet conservé : ${ref.storage} ${ref.key}`,
      );
      return 'failed';
    }
  }
}
