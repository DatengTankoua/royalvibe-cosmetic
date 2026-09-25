import { ArrayUnique, IsArray, IsIn, IsOptional } from 'class-validator';
import {
  DELEGABLE_PERMISSIONS,
  DelegablePermission,
  MembershipStatus,
  OrganizationRole,
} from '../permissions';

/** Rôles attribuables via cette route — jamais `owner` (transfert dédié). */
export const ASSIGNABLE_MEMBER_ROLES = [
  OrganizationRole.ADMIN,
  OrganizationRole.SELLER,
] as const;

export class UpdateMembershipDto {
  @IsOptional()
  @IsIn(ASSIGNABLE_MEMBER_ROLES)
  role?: (typeof ASSIGNABLE_MEMBER_ROLES)[number];

  @IsOptional()
  @IsArray()
  @IsIn(DELEGABLE_PERMISSIONS, { each: true })
  @ArrayUnique()
  permissions?: DelegablePermission[];

  @IsOptional()
  @IsIn([
    MembershipStatus.ACTIVE,
    MembershipStatus.SUSPENDED,
    MembershipStatus.REVOKED,
  ])
  status?: MembershipStatus;
}
