import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { SubscriptionTerm } from '../../subscription-terms';
import { PAYER_PHONE_INPUT_MAX_LENGTH } from '../payment-request';

/**
 * 1-14D.2B — Seuls champs acceptés (`forbidNonWhitelisted` global : tout
 * autre champ — montant, devise, organisation, demandeur, prestataire,
 * statut… — est refusé en 400). Le montant vient du catalogue serveur.
 */
export class CreateSubscriptionPaymentDto {
  @IsString()
  @IsIn(Object.values(SubscriptionTerm))
  term: SubscriptionTerm;

  /** Normalisé et validé par le service (`INVALID_PAYER_PHONE`). */
  /**
   * 1-21B — facultatif : exigé seulement par un prestataire qui pousse la
   * collecte sur le téléphone ; inutile pour une page de paiement hébergée.
   */
  @IsOptional()
  @IsString()
  @MaxLength(PAYER_PHONE_INPUT_MAX_LENGTH)
  payerPhone?: string;

  /** Généré UNE fois par le client, stable sur tous les rejeux. */
  @IsUUID('4')
  clientOperationId: string;
}

export const PAYMENT_HISTORY_DEFAULT_LIMIT = 20;
export const PAYMENT_HISTORY_MAX_LIMIT = 50;

/** Historique : du plus récent au plus ancien, curseur `before` (id). */
export class ListSubscriptionPaymentsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAYMENT_HISTORY_MAX_LIMIT)
  limit?: number;

  @IsOptional()
  @IsMongoId()
  before?: string;
}
