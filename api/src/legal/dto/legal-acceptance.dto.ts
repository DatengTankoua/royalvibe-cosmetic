import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';

/** Document AFFICHÉ par le navigateur : identifiant et version, rien d'autre. */
export class LegalDocumentRefDto {
  @IsString()
  @Matches(/^[a-z][a-z-]{0,39}$/)
  id: string;

  @IsString()
  @Matches(/^\d{1,3}\.\d{1,3}$/)
  version: string;
}

/**
 * 1-16C.2 — Ce que le navigateur a affiché et coché. Aucune date, empreinte,
 * texte, utilisateur ni commerce n'est accepté (`forbidNonWhitelisted`
 * global, y compris dans les objets imbriqués) : le serveur les détermine.
 * `accepted` doit valoir `true` (contrôlé par le service, code stable).
 */
export class LegalAcceptanceDto {
  @IsBoolean()
  accepted: boolean;

  @IsString()
  @Matches(/^[a-z]{2}$/)
  locale: string;

  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => LegalDocumentRefDto)
  documents: LegalDocumentRefDto[];

  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => LegalDocumentRefDto)
  notices: LegalDocumentRefDto[];
}
