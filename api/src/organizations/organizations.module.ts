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
import { SocketRegistryService } from './socket-registry.service';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    UsersModule,
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
  controllers: [OrganizationsController, OrganizationMembersController],
  providers: [OrganizationsService, SocketRegistryService],
  exports: [OrganizationsService, SocketRegistryService],
})
export class OrganizationsModule {}
