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

/**
 * Phase 1-1A — socle de données multi-tenant.
 *
 * Le module enregistre UNIQUEMENT les modèles `Organization` et
 * `OrganizationMembership` (aucun controller, aucun service, aucune API
 * métier : endpoints et services arrivent en 1-3A+). Aucun champ
 * `organizationId` n'est ajouté aux ressources métier ici (phase 1-1B)
 * et aucun schéma `OrganizationInvitation` n'existe (phase 1-6).
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Organization.name, schema: OrganizationSchema },
      {
        name: OrganizationMembership.name,
        schema: OrganizationMembershipSchema,
      },
    ]),
  ],
})
export class OrganizationsModule {}
