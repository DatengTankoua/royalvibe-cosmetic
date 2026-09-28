import {
  IsInt,
  IsISO8601,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 1-11C.1 — ISO 8601 en UTC STRICT (`Z` obligatoire, aucun décalage),
 * millisecondes optionnelles. La plage métier (14 j passés / 5 min futures)
 * est validée par le service (`SALE_DATE_OUT_OF_RANGE`).
 */
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export class CreateSaleDto {
  @IsMongoId()
  productId: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  salePrice: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  buyerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  buyerContact?: string;

  /**
   * 1-11C.1 — clé d'idempotence générée UNE fois par le client et stable sur
   * tous les rejeux. Absente : comportement historique (aucune dédup).
   */
  @IsOptional()
  @IsUUID('4')
  clientOperationId?: string;

  /** 1-11C.1 — heure réelle de la vente ; absente → heure serveur. */
  @IsOptional()
  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(ISO_8601_UTC)
  occurredAt?: string;
}
