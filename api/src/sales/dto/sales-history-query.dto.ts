import { Type } from 'class-transformer';
import {
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { SALES_HISTORY_MAX_LIMIT } from '../sale-history';

/** 1-20E — Paramètres de `GET /sales/history` (champs inconnus refusés). */
export class SalesHistoryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SALES_HISTORY_MAX_LIMIT)
  limit?: number;

  /** Curseur opaque renvoyé par la page précédente (`nextCursor`). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9_-]+$/)
  cursor?: string;

  @IsOptional()
  @IsMongoId()
  productId?: string;
}
