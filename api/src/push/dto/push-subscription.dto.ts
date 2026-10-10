import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { PUSH_ENDPOINT_MAX_LENGTH } from '../push-endpoint-policy';

/**
 * 1-16A — Corps des routes de gestion. Formes et tailles bornées ici ; la
 * destination (services push autorisés) et les clés (longueurs décodées)
 * sont validées par `validatePushSubscriptionInput`. Jamais d'utilisateur,
 * d'organisation ni de rôle dans un corps : contexte serveur uniquement.
 */
export class PushKeysDto {
  @IsString()
  @MaxLength(100)
  p256dh: string;

  @IsString()
  @MaxLength(32)
  auth: string;
}

export class PushBrowserSubscriptionDto {
  @IsString()
  @MaxLength(PUSH_ENDPOINT_MAX_LENGTH)
  endpoint: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => PushKeysDto)
  keys: PushKeysDto;
}

export class PushPreferencesDto {
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

  @IsOptional()
  @IsBoolean()
  memberJoined?: boolean;

  @IsOptional()
  @IsBoolean()
  memberActivity?: boolean;
}

export class RegisterPushSubscriptionDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => PushBrowserSubscriptionDto)
  subscription: PushBrowserSubscriptionDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => PushPreferencesDto)
  preferences?: PushPreferencesDto;
}

export class PushEndpointDto {
  @IsString()
  @MaxLength(PUSH_ENDPOINT_MAX_LENGTH)
  endpoint: string;
}

export class UpdatePushPreferencesDto extends PushEndpointDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => PushPreferencesDto)
  preferences: PushPreferencesDto;
}
