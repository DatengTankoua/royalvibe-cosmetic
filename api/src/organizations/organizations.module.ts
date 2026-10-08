import { LegalModule } from '../legal/legal.module';
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
import { InvitationCreateThrottlerGuard } from '../common/invitation-rate-limiting';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

@Module({
  imports: [
    UsersModule,
    S3Module,
    // 1-14B : essai attribué dans la transaction de création.
    SubscriptionsModule,
    // 1-16C.2 : preuve d'acceptation dans la transaction d'invitation.
    LegalModule,
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
  providers: [
    OrganizationsService,
    SocketRegistryService,
    // Rate limiting (1-10B) : garde de MÉTHODE (jamais globale), résolue
    // ici car `OrganizationsController` (qui l'utilise via `@UseGuards`)
    // appartient à ce module. Injecte les tokens GLOBAUX de l'UNIQUE
    // `ThrottlerModule.forRoot()` (`auth.module.ts`) sans avoir besoin de
    // l'importer explicitement (`ThrottlerModule` est `@Global()`).
    InvitationCreateThrottlerGuard,
  ],
  exports: [OrganizationsService, SocketRegistryService],
})
export class OrganizationsModule {}
