import {
  ArrayUnique,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
} from 'class-validator';
import { DELEGABLE_PERMISSIONS, DelegablePermission } from '../permissions';
import { INVITABLE_ROLES } from '../schemas/invitation.schema';

export class CreateInvitationDto {
  @IsEmail()
  email: string;

  // Jamais `owner` : rôle exclu de INVITABLE_ROLES (unique, transféré, non invité).
  @IsIn(INVITABLE_ROLES)
  role: (typeof INVITABLE_ROLES)[number];

  @IsOptional()
  @IsArray()
  @IsIn(DELEGABLE_PERMISSIONS, { each: true })
  @ArrayUnique()
  permissions?: DelegablePermission[];
}
