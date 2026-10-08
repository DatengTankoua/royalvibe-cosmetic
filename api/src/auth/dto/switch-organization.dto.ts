import { IsMongoId } from 'class-validator';

export class SwitchOrganizationDto {
  @IsMongoId()
  organizationId: string;
}
