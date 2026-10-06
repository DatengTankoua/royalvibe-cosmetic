import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

/** 1-16A.1 — `GET /notifications` : filtre et pagination par curseur. */
export class ListNotificationsQueryDto {
  @IsOptional()
  @IsIn(['all', 'unread'])
  status?: 'all' | 'unread';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsMongoId()
  before?: string;
}

export class ReportUnsoldQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** Préférences du centre (catégories absentes : inchangées). */
export class NotificationPreferencesDto {
  @IsOptional()
  @IsBoolean()
  stockDepleted?: boolean;

  @IsOptional()
  @IsBoolean()
  stockLow?: boolean;

  @IsOptional()
  @IsBoolean()
  saleCreated?: boolean;

  @IsOptional()
  @IsBoolean()
  subscriptionEnding?: boolean;

  @IsOptional()
  @IsBoolean()
  paymentSucceeded?: boolean;

  @IsOptional()
  @IsBoolean()
  monthlyReport?: boolean;
}
