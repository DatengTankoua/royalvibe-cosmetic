import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { OrganizationsService } from './organizations.service';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import type { ResolvedOrganizationContext } from './organizations.service';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { InvitationCreateThrottlerGuard } from '../common/invitation-rate-limiting';
import { SKIP_PAYMENT_THROTTLERS } from '../common/subscription-payment-rate-limiting';
import { SKIP_SUPPORT_THROTTLER } from '../support/support-rate-limiting';
import { User } from '../users/schemas/user.schema';
import { PushOutboxService } from '../push/push-outbox.service';
import {
  MemberActivityAction,
  MemberActivityEntity,
} from '../notifications/member-activity';

/**
 * Invitations tenant-scopées (1-6B.1) : autorisation `members.invite`
 * (1-7B, `PermissionGuard` global) — plus d'exception `owner`, cette
 * permission est déjà déléguée par défaut à `admin` (§3 audit 1A).
 * `organizationId` provient exclusivement du contexte branché par
 * `OrganizationGuard` — jamais du body/query/header.
 */
@Controller('organizations/invitations')
@RequirePermissions('members.invite')
export class OrganizationsController {
  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly pushOutbox: PushOutboxService,
  ) {}

  // Rate limiting (correction sécurité 1-10B) : fenêtre nommée dédiée
  // (`invitation-create`, 5 créations / 60 s), tracker utilisateur+
  // organisation — jamais les fenêtres de connexion (skip explicite) et
  // jamais appliquée à GET/revoke ci-dessous (garde de MÉTHODE, pas de
  // classe). S'exécute APRÈS les gardes globaux (Jwt/OrganizationGuard/
  // PermissionGuard/RolesGuard) : un refus de permission ne consomme
  // jamais ce quota.
  @UseGuards(InvitationCreateThrottlerGuard)
  @SkipThrottle({
    'login-short': true,
    'login-long': true,
    ...SKIP_PAYMENT_THROTTLERS,
    ...SKIP_SUPPORT_THROTTLER,
  })
  @Post()
  async create(
    @Body() dto: CreateInvitationDto,
    @CurrentUser() user: User,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    const created = await this.organizationsService.createInvitation(
      organizationContext.organizationId,
      user._id.toString(),
      dto,
    );
    // 1-19A : annoncée au propriétaire (adresse invitée seule, jamais le
    // lien ni le jeton). Aucun e-mail n'est envoyé à l'invité.
    await this.pushOutbox.memberActivity(organizationContext, {
      entity: MemberActivityEntity.INVITATION,
      action: MemberActivityAction.CREATED,
      targetId: created.invitation._id,
      targetName: created.invitation.email,
    });
    return created;
  }

  @Get()
  findAll(
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.organizationsService.listInvitations(
      organizationContext.organizationId,
    );
  }

  // 200 explicite : une révocation renvoie la vue résultante (le POST
  // par défaut NestJS répond 201 — trompeur pour une mutation d'état).
  @HttpCode(200)
  @Post(':id/revoke')
  async revoke(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    const revoked = await this.organizationsService.revokeInvitation(
      organizationContext.organizationId,
      id,
    );
    await this.pushOutbox.memberActivity(organizationContext, {
      entity: MemberActivityEntity.INVITATION,
      action: MemberActivityAction.REVOKED,
      targetId: revoked._id,
      targetName: revoked.email,
      uniqueKey: id,
    });
    return revoked;
  }
}
