import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { SignedUrlCache } from './signed-url-cache';

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

/**
 * 1-17B — Taille d'un objet lue par `HeadObject` (métadonnées seules, aucun
 * téléchargement) :
 * - `present` : objet présent, `bytes` = `Content-Length` du stockage ;
 * - `absent` : absence CONFIRMÉE par le stockage (404) ;
 * - `unknown` : réponse impossible (réseau, droits, taille absente) —
 *   jamais interprétée comme une absence ni comme une taille nulle ;
 * - `retained` : autre stockage ou hors du préfixe exact : non consulté.
 */
export type StoredObjectHead =
  | { state: 'present'; bytes: number }
  | { state: 'absent' }
  | { state: 'unknown' }
  | { state: 'retained' };

/** 1-17B — objet listé (inventaire) : clé, taille et date du stockage. */
export interface ListedObject {
  key: string;
  bytes: number;
  lastModified: Date | null;
}

/** Préfixe racine des fichiers d'organisation (seul préfixe inventorié). */
export const ORGANIZATIONS_PREFIX = 'organizations/';

/** Durée de validité par défaut d'une URL de lecture signée (15 min). */
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 900;
const MIN_SIGNED_URL_TTL_SECONDS = 60;
const MAX_SIGNED_URL_TTL_SECONDS = 3600;
/**
 * 1-20C — Réutilisation d'une URL signée : au plus le TIERS de sa validité
 * après signature (300 s pour 900 s). Toute URL délivrée garde donc au moins
 * les deux tiers de sa validité (≥ 600 s par défaut), au-delà du délai de
 * 5 min entre deux renouvellements d'une même image côté web.
 */
export const SIGNED_URL_REUSE_FRACTION = 1 / 3;
/** 1-20C — Entrées au plus (≈ 0,6 Ko par URL : quelques Mo). */
export const SIGNED_URL_CACHE_MAX_ENTRIES = 10_000;

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

/**
 * Endpoint de SIGNATURE facultatif (`S3_SIGNING_ENDPOINT`) : hôte que le
 * NAVIGATEUR joint pour lire une URL GET signée, quand l'API joint le
 * stockage par un nom interne (Docker Compose : `http://minio:9000`,
 * navigateur : `https://s3.<domaine>` derrière nginx). Absent = même
 * endpoint (R2). Origine http(s) seule, sans chemin ni identifiants.
 */
function parseSigningEndpoint(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new StorageConfigError('S3_SIGNING_ENDPOINT doit être une URL');
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new StorageConfigError(
      'S3_SIGNING_ENDPOINT doit être une origine http(s), sans chemin',
    );
  }
  return url.origin;
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
  /** Client des seules URL GET signées (même client sans endpoint dédié). */
  private readonly signingClient: S3Client;
  private readonly bucket: string;
  /** Identité du stockage courant ; `null` si endpoint/bucket absents. */
  readonly storage: string | null;
  readonly signedUrlTtlSeconds: number;
  /** 1-20C : URL GET signées réutilisées (bornées, voir `SignedUrlCache`). */
  private readonly signedUrls: SignedUrlCache;
  /** 1-20C : tout ce qui, hors clé d'objet, détermine la signature. */
  private readonly signingContext: string;

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

    const signingEndpoint = parseSigningEndpoint(
      this.configService.get<string>('S3_SIGNING_ENDPOINT'),
    );

    const clientFor = (target: string | undefined) =>
      new S3Client({
        endpoint: target,
        region: this.configService.get<string>('S3_REGION'),
        credentials: {
          accessKeyId: this.configService.get<string>('S3_ACCESS_KEY') ?? '',
          secretAccessKey:
            this.configService.get<string>('S3_SECRET_KEY') ?? '',
        },
        forcePathStyle:
          this.configService.get<string>('S3_FORCE_PATH_STYLE') === 'true',
        requestChecksumCalculation: checksum,
        responseChecksumValidation: checksum,
      });
    // Opérations serveur (envoi, suppression) : endpoint interne. L'identité
    // durable du stockage (`storage`) en dépend SEULE : le nom d'hôte vu par
    // le navigateur ne la change jamais.
    this.s3Client = clientFor(endpoint);
    // URL GET signées : signées DIRECTEMENT pour l'hôte du navigateur (la
    // signature SigV4 couvre l'hôte) — jamais réécrites après signature.
    this.signingClient = signingEndpoint
      ? clientFor(signingEndpoint)
      : this.s3Client;
    this.signingContext = JSON.stringify([
      this.storage,
      this.bucket,
      signingEndpoint ?? endpoint ?? null,
      this.configService.get<string>('S3_REGION') ?? null,
      this.configService.get<string>('S3_ACCESS_KEY') ?? '',
      this.configService.get<string>('S3_FORCE_PATH_STYLE') === 'true',
      checksum,
      this.signedUrlTtlSeconds,
    ]);
    this.signedUrls = new SignedUrlCache({
      maxEntries: SIGNED_URL_CACHE_MAX_ENTRIES,
      reuseMs: Math.floor(
        this.signedUrlTtlSeconds * 1000 * SIGNED_URL_REUSE_FRACTION,
      ),
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
    options: { key?: string; abortSignal?: AbortSignal } = {},
  ): Promise<StoredObjectRef> {
    if (!this.storage) throw new Error('Stockage non configuré');
    // 1-17B : clé réservée AVANT l'envoi (comptabilisation), toujours
    // générée côté serveur (`newObjectKey`) et sous le préfixe exact.
    const key = options.key ?? this.newObjectKey(keyPrefix, image.extension);
    if (!isWithinPrefix(key, keyPrefix)) {
      throw new Error('Clé hors du préfixe attendu');
    }

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: image.contentType,
      }),
      options.abortSignal ? { abortSignal: options.abortSignal } : undefined,
    );

    return { key, storage: this.storage };
  }

  /** Clé serveur `${keyPrefix}/${uuid}.${extension}` (aucun nom client). */
  newObjectKey(keyPrefix: string, extension: string): string {
    return `${keyPrefix}/${randomUUID()}.${extension}`;
  }

  /**
   * 1-17B — Inventaire d'une page d'objets du stockage COURANT sous un
   * préfixe d'organisations (`organizations/…` uniquement, jamais la racine
   * du bucket). Métadonnées seules (aucun téléchargement). Lève en cas
   * d'échec : un inventaire incomplet n'est jamais pris pour un état exact.
   */
  async listStoredObjects(
    prefix: string,
    continuationToken?: string,
  ): Promise<{ objects: ListedObject[]; next?: string }> {
    if (!this.storage) throw new Error('Stockage non configuré');
    if (!prefix.startsWith(ORGANIZATIONS_PREFIX)) {
      throw new Error('Préfixe d’inventaire non autorisé');
    }
    const page = await this.s3Client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    );
    const objects: ListedObject[] = [];
    for (const item of page.Contents ?? []) {
      if (typeof item.Key !== 'string') continue;
      if (typeof item.Size !== 'number' || !Number.isInteger(item.Size)) {
        throw new Error('Taille absente dans l’inventaire');
      }
      objects.push({
        key: item.Key,
        bytes: item.Size,
        lastModified: item.LastModified ?? null,
      });
    }
    return {
      objects,
      next: page.IsTruncated ? page.NextContinuationToken : undefined,
    };
  }

  /**
   * 1-17B — Taille réelle d'un objet (`HeadObject`, métadonnées seules),
   * dans le stockage courant et sous le préfixe EXACT attendu uniquement.
   */
  async headStoredObject(
    ref: StoredObjectRef,
    allowedPrefix: string,
  ): Promise<StoredObjectHead> {
    if (!this.storage || ref.storage !== this.storage) {
      return { state: 'retained' };
    }
    if (!isWithinPrefix(ref.key, allowedPrefix)) return { state: 'retained' };
    try {
      const head = await this.s3Client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: ref.key }),
      );
      const bytes = head.ContentLength;
      return typeof bytes === 'number' && Number.isInteger(bytes) && bytes >= 0
        ? { state: 'present', bytes }
        : { state: 'unknown' };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })
        ?.$metadata?.httpStatusCode;
      const name = (err as { name?: string })?.name;
      if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') {
        return { state: 'absent' };
      }
      this.logger.warn('Lecture de taille impossible');
      return { state: 'unknown' };
    }
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
    // 1-20C : contrôles ci-dessus TOUJOURS exécutés ; seule la signature
    // est réutilisée (clé d'objet immuable : une nouvelle photo a une
    // nouvelle clé). Échec : `null`, jamais mis en cache.
    const key = `${this.signingContext}\u0000${ref.key}`;
    return this.signedUrls.get(key, async () => {
      try {
        return await getSignedUrl(
          this.signingClient,
          new GetObjectCommand({ Bucket: this.bucket, Key: ref.key }),
          { expiresIn: this.signedUrlTtlSeconds },
        );
      } catch {
        this.logger.warn('Signature de lecture impossible');
        return null;
      }
    });
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
