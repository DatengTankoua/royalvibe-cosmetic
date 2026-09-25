import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  Organization,
  OrganizationSchema,
} from './schemas/organization.schema';
import {
  OrganizationMembership,
  OrganizationMembershipSchema,
} from './schemas/membership.schema';
import {
  OrganizationInvitation,
  OrganizationInvitationSchema,
} from './schemas/invitation.schema';
import { OrganizationsService } from './organizations.service';
import { OrganizationsController } from './organizations.controller';
import { OrganizationMembersController } from './organization-members.controller';
import { OrganizationBrandingController } from './organization-branding.controller';
import { SocketRegistryService } from './socket-registry.service';
import { UsersModule } from '../users/users.module';
import { S3Module } from '../s3/s3.module';

@Module({
  imports: [
    UsersModule,
    S3Module,
    MongooseModule.forFeature([
      { name: Organization.name, schema: OrganizationSchema },
      {
        name: OrganizationMembership.name,
        schema: OrganizationMembershipSchema,
      },
      {
        name: OrganizationInvitation.name,
        schema: OrganizationInvitationSchema,
      },
    ]),
  ],
  controllers: [
    OrganizationsController,
    OrganizationMembersController,
    OrganizationBrandingController,
  ],
  providers: [OrganizationsService, SocketRegistryService],
  exports: [OrganizationsService, SocketRegistryService],
})
export class OrganizationsModule {}
