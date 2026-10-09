import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { OrganizationsService } from '../organizations/organizations.service';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import { effectivePermissions } from '../organizations/permissions';
import { AllowInactiveSubscription } from '../subscriptions/subscription-access';
import {
  AuthThrottlerGuard,
  LoginSharedThrottlerGuard,
  clientKeyFor,
} from '../common/auth-rate-limiting';
import { SKIP_PAYMENT_THROTTLERS } from '../common/subscription-payment-rate-limiting';
import { SKIP_SUPPORT_THROTTLER } from '../support/support-rate-limiting';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { SwitchOrganizationDto } from './dto/switch-organization.dto';
import {
  AcceptInvitationDto,
  AcceptInvitationWithCredentialsDto,
  CreateInvitationAccountDto,
  InvitationCredentialsDto,
  InvitationTokenDto,
} from './dto/accept-invitation.dto';
import {
  INVITATION_ACCOUNT_LINK_ACCEPTED_MESSAGE,
  InvitationAcceptanceService,
} from '../organizations/invitation-acceptance.service';
import { localeFromRequest } from '../common/i18n/locale';
import { TurnstileService } from '../anti-bot/turnstile.service';
import {
  TURNSTILE_EMAIL_VERIFICATION_ACTION,
  TURNSTILE_PASSWORD_RESET_ACTION,
  TURNSTILE_REGISTER_ACTION,
} from '../anti-bot/turnstile-config';
import { UpdateLocaleDto } from './dto/update-locale.dto';
import { UsersService } from '../users/users.service';
import { Public } from './decorators/public.decorator';
import { SkipOrganizationContext } from './decorators/skip-organization-context.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { CurrentOrganization } from './decorators/current-organization.decorator';
import { User } from '../users/schemas/user.schema';
import type { AuthenticatedPrincipal } from './strategies/jwt.strategy';
import { EmailVerificationService } from '../email-verification/email-verification.service';
import {
  AddressRequestLimiter,
  EMAIL_VERIFICATION_ADDRESS_THROTTLER,
  EMAIL_VERIFICATION_RATE_LIMIT_CODE,
} from '../email-verification/email-verification-rate-limiting';
import {
  ConfirmEmailVerificationDto,
  RequestEmailVerificationDto,
} from '../email-verification/email-verification.dto';
import { PasswordResetService } from '../password-reset/password-reset.service';
import {
  PASSWORD_RESET_ADDRESS_THROTTLER,
  PASSWORD_RESET_RATE_LIMIT_CODE,
} from '../password-reset/password-reset-rate-limiting';
import {
  ConfirmPasswordResetDto,
  RequestPasswordResetDto,
} from '../password-reset/password-reset.dto';

/** Réponse neutre du renvoi public (1-13A) : identique pour toute adresse. */
export const PASSWORD_RESET_REQUEST_ACCEPTED_MESSAGE =
  'Si un compte correspond à cette adresse, vous recevrez un lien pour réinitialiser votre mot de passe.';

export const EMAIL_VERIFICATION_REQUEST_ACCEPTED_MESSAGE =
  "Si un compte non vérifié correspond à cette adresse, un nouveau lien de confirmation vient d'être envoyé.";

/**
 * Registre public ouvert (phase 0B.5) — désactivé PAR DÉFAUT.
 * Seule la valeur exacte 'true' l'active ; toute autre valeur
 * (absente, 'false', invalide) le désactive. Le backend reste
 * l'autorité finale, quel que soit le flag frontend
 * (NEXT_PUBLIC_REGISTRATION_ENABLED ne porte que l'affichage).
 * Fermeture TEMPORAIRE, remplacée par : inscription du gérant
 * (OWNER), création de son organisation, invitation des vendeurs.
 */
export function isPublicRegistrationEnabled(): boolean {
  return process.env.PUBLIC_REGISTRATION_ENABLED === 'true';
}

// `AuthThrottlerGuard` (login/register/invitations) trace par IP ;
// exclusion explicite de la fenêtre `invitation-create` (1-10B, tracker
// utilisateur+organisation, sans rapport avec ces routes publiques) —
// jamais l'inverse (`OrganizationsController` exclut symétriquement les
// fenêtres `login-short`/`login-long`).
// 1-14D.2B : idem pour les fenêtres des paiements d'abonnement.
@SkipThrottle({
  'invitation-create': true,
  ...SKIP_PAYMENT_THROTTLERS,
  ...SKIP_SUPPORT_THROTTLER,
})
@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private organizationsService: OrganizationsService,
    private emailVerificationService: EmailVerificationService,
    private passwordResetService: PasswordResetService,
    private usersService: UsersService,
    private invitationAcceptance: InvitationAcceptanceService,
    private turnstile: TurnstileService,
    private addressLimiter: AddressRequestLimiter,
  ) {}

  // Rate limiting (0B.6) : MÊME garde/fenêtres que /auth/login, sans
  // stockage séparé — clé générée par handler, donc compteur distinct.
  @UseGuards(AuthThrottlerGuard)
  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto) {
    // Garde AVANT toute logique : AuthService.register n'est JAMAIS
    // appelée en cas de refus (403 + code stable REGISTRATION_DISABLED).
    const enabled = isPublicRegistrationEnabled();
    if (!enabled) {
      throw new ForbiddenException({
        code: 'REGISTRATION_DISABLED',
        message: "L'inscription est actuellement désactivée.",
      });
    }
    return this.verifiedRegistration(dto);
  }

  /**
   * 1-18C — Vérification anti-robot AVANT toute logique d'inscription
   * (aucun hachage, compte, organisation, preuve ni e-mail sans réponse
   * positive de Turnstile). Indisponible ou non configuré → 503 réessayable.
   */
  private async verifiedRegistration(dto: RegisterDto) {
    await this.turnstile.verify(dto.turnstileToken, TURNSTILE_REGISTER_ACTION);
    return this.authService.register(dto);
  }

  // Garde de rate limiting (0B.6) : applicée UNIQUEMENT à /auth/login
  // (jamais en garde globale), avant la logique de login.
  @UseGuards(AuthThrottlerGuard)
  @Header('Cache-Control', 'no-store')
  @Public()
  @Post('login')
  login(@Body() dto: LoginDto, @Req() request: Request) {
    return this.authService.login(dto, { clientKey: clientKeyFor(request.ip) });
  }
  // 1-18B : le lien d'invitation est remis au créateur ; il ne prouve ni
  // l'identité de son détenteur ni le contrôle de l'adresse invitée.
  // Compte existant : session de CE compte + accord explicite. Nouveau
  // compte : second lien envoyé à l'adresse invitée. Toutes ces routes sont
  // INDÉPENDANTES de PUBLIC_REGISTRATION_ENABLED et limitées par IP.
  //
  // Session requise (JWT applicatif ou limité : l'abonnement de
  // l'organisation COURANTE n'intervient pas, aucune adhésion préalable à
  // l'organisation cible). Sans session : 401 avant tout contrôle du corps.
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthThrottlerGuard)
  @AllowInactiveSubscription('identity')
  @SkipOrganizationContext()
  @Post('invitations/inspect')
  inspectInvitation(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: InvitationTokenDto,
  ) {
    return this.invitationAcceptance.inspect(dto.token, user);
  }

  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthThrottlerGuard)
  @AllowInactiveSubscription('identity')
  @SkipOrganizationContext()
  @Post('invitations/accept')
  acceptInvitation(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: AcceptInvitationDto,
  ) {
    return this.invitationAcceptance.acceptForAccount(dto, user);
  }

  // Compte existant SANS organisation active : la connexion lui est refusée
  // (aucun JWT possible), l'identité est donc prouvée par les identifiants,
  // avec la MÊME vérification que le login (mot de passe, adresse vérifiée)
  // et les MÊMES compteurs de limitation (aucun essai supplémentaire par
  // IP). Aucun JWT n'est délivré : aucune route métier ni d'organisation
  // n'est accessible avant l'adhésion, puis via un login normal.
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(LoginSharedThrottlerGuard)
  @Public()
  @Post('invitations/credentials/inspect')
  async inspectInvitationWithCredentials(
    @Body() dto: InvitationCredentialsDto,
    @Req() request: Request,
  ) {
    const user = await this.authService.verifyCredentials(
      dto.email,
      dto.password,
      {
        challengeToken: dto.challengeToken,
        clientKey: clientKeyFor(request.ip),
      },
    );
    return this.invitationAcceptance.inspect(dto.token, user);
  }

  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(LoginSharedThrottlerGuard)
  @Public()
  @Post('invitations/credentials/accept')
  async acceptInvitationWithCredentials(
    @Body() dto: AcceptInvitationWithCredentialsDto,
    @Req() request: Request,
  ) {
    const user = await this.authService.verifyCredentials(
      dto.email,
      dto.password,
      {
        challengeToken: dto.challengeToken,
        clientKey: clientKeyFor(request.ip),
      },
    );
    return this.invitationAcceptance.acceptForAccount(
      { token: dto.token, consent: dto.consent },
      user,
    );
  }

  // Public : réponse neutre (202) quel que soit l'état du compte invité ;
  // recherche, réservation et envoi après la réponse.
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthThrottlerGuard)
  @Public()
  @Post('invitations/account-link')
  async requestInvitationAccountLink(
    @Body() dto: InvitationTokenDto,
    @Req() request: Request,
  ) {
    const { delivery } = await this.invitationAcceptance.requestAccountLink(
      dto.token,
      localeFromRequest(request),
    );
    void delivery;
    return { message: INVITATION_ACCOUNT_LINK_ACCEPTED_MESSAGE };
  }

  // Public : `token` = lien reçu à l'adresse invitée. Compte créé vérifié,
  // aucun JWT, aucune connexion automatique.
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthThrottlerGuard)
  @Public()
  @Post('invitations/create-account')
  createInvitationAccount(@Body() dto: CreateInvitationAccountDto) {
    return this.invitationAcceptance.createAccount(dto);
  }

  // 1-13A : (ré)envoi public du lien de vérification. Réponse neutre :
  // compte inexistant, déjà vérifié, en cooldown ou échec fournisseur
  // répondent à l'identique ; l'envoi n'est pas attendu.
  // 1-18D — Ordre : limite IP (garde) → validation du corps (pipe) →
  // Turnstile (action `email-verification`) → limite par adresse → métier.
  // Sans défi valide : ni quota d'adresse, ni jeton, ni e-mail. Un défi
  // réussi ne prouve pas la possession de l'adresse et ne remet rien à zéro.
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthThrottlerGuard)
  @Public()
  @Post('email-verification/request')
  async requestEmailVerification(@Body() dto: RequestEmailVerificationDto) {
    await this.turnstile.verify(
      dto.turnstileToken,
      TURNSTILE_EMAIL_VERIFICATION_ACTION,
    );
    await this.addressLimiter.consume(
      EMAIL_VERIFICATION_ADDRESS_THROTTLER,
      EMAIL_VERIFICATION_RATE_LIMIT_CODE,
      dto.email,
    );
    const { delivery } = this.emailVerificationService.requestByEmail(
      dto.email,
    );
    void delivery;
    return { message: EMAIL_VERIFICATION_REQUEST_ACCEPTED_MESSAGE };
  }

  // 1-13A : confirmation par POST explicite uniquement (jamais par GET ni
  // préchargement du lien). Aucun JWT, aucune connexion automatique.
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthThrottlerGuard)
  @Public()
  @Post('email-verification/confirm')
  async confirmEmailVerification(@Body() dto: ConfirmEmailVerificationDto) {
    await this.emailVerificationService.confirm(dto.token);
    return { verified: true };
  }

  // 1-13B : demande de réinitialisation. Réponse neutre ; recherche du
  // compte et envoi après la réponse.
  // 1-18D — Même ordre que la vérification d'email, action `password-reset`.
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthThrottlerGuard)
  @Public()
  @Post('password-reset/request')
  async requestPasswordReset(@Body() dto: RequestPasswordResetDto) {
    await this.turnstile.verify(
      dto.turnstileToken,
      TURNSTILE_PASSWORD_RESET_ACTION,
    );
    await this.addressLimiter.consume(
      PASSWORD_RESET_ADDRESS_THROTTLER,
      PASSWORD_RESET_RATE_LIMIT_CODE,
      dto.email,
    );
    const { delivery } = this.passwordResetService.requestByEmail(dto.email);
    void delivery;
    return { message: PASSWORD_RESET_REQUEST_ACCEPTED_MESSAGE };
  }

  // 1-13B : confirmation explicite. Aucun JWT, aucune connexion automatique ;
  // toutes les sessions antérieures de l'utilisateur sont révoquées.
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthThrottlerGuard)
  @Public()
  @Post('password-reset/confirm')
  async confirmPasswordReset(@Body() dto: ConfirmPasswordResetDto) {
    await this.passwordResetService.confirm(dto.token, dto.password);
    return { reset: true };
  }
  // 200 explicite : le switch répond un nouveau JWT (le POST par défaut
  // NestJS répond 201 — le conserver ici serait trompeur).
  // 1-9B : @SkipOrganizationContext — l'organisation COURANTE (JWT) peut
  // être devenue inactive ; seule la cible (dto.organizationId) est
  // validée, par AuthService.switchOrganization → resolveActiveContext.
  // 1-14C.1 : exception `identity` (l'organisation courante peut être
  // expirée) ; le service refuse un jeton limité et applique le contrôle
  // commercial à l'organisation CIBLE.
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @AllowInactiveSubscription('identity')
  @SkipOrganizationContext()
  @Post('switch-organization')
  switchOrganization(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: SwitchOrganizationDto,
  ) {
    // Le sub provient de l'utilisateur authentifié (JWT) — jamais du body.
    // 1-13B : version de session validée du JWT appelant, jamais du client.
    return this.authService.switchOrganization(
      user._id.toString(),
      dto,
      user.sessionVersion,
      user.accessScope,
    );
  }

  // 1-14C.1 : jeton LIMITÉ → JWT applicatif, seulement si l'abonnement est
  // actif. Body vide strict (refus 400 sinon) : aucun organizationId,
  // rôle, statut, paiement ou date accepté. Organisation = contexte serveur.
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @AllowInactiveSubscription('identity')
  @Post('subscription-access/complete')
  completeSubscriptionAccess(
    @CurrentUser() user: AuthenticatedPrincipal,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
    @Body() body: unknown,
  ) {
    // Corps vide uniquement : aucune donnée client n'entre dans l'échange.
    if (
      body !== undefined &&
      body !== null &&
      (typeof body !== 'object' || Object.keys(body).length > 0)
    ) {
      throw new BadRequestException({
        code: 'UNEXPECTED_BODY',
        message: 'Aucun paramètre attendu.',
      });
    }
    return this.authService.completeSubscriptionAccess(
      user,
      organizationContext,
    );
  }

  // 1-9B : organisations actives de l'utilisateur courant (userId
  // exclusivement du JWT) — alimente le sélecteur de switch frontend.
  // @SkipOrganizationContext : doit rester listable même si l'organisation
  // COURANTE du JWT est devenue inactive.
  @Header('Cache-Control', 'no-store')
  @AllowInactiveSubscription('identity')
  @SkipOrganizationContext()
  @Get('organizations')
  organizations(@CurrentUser() user: User) {
    return this.organizationsService.listActiveOrganizations(
      user._id.toString(),
    );
  }

  // 1-14C.1 : identification minimale, JWT applicatif ou limité.
  @Header('Cache-Control', 'no-store')
  @AllowInactiveSubscription('identity')
  @Get('me')
  me(@CurrentUser() user: AuthenticatedPrincipal) {
    // 1-13B : champs explicites — la version de session reste interne.
    return {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId,
      // 1-16G : langue des e-mails et notifications (`null` : jamais choisie,
      // envois en français).
      locale: user.locale ?? null,
    };
  }

  // 1-16G : préférence de langue du compte (e-mails, notifications push).
  // Identité seule (`sub` du JWT, jamais du corps) ; aucune organisation,
  // aucun droit ni état commercial requis : une session limitée peut aussi
  // l'enregistrer. Seul `User.locale` est modifié.
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @AllowInactiveSubscription('identity')
  @SkipOrganizationContext()
  @Put('me/locale')
  async updateLocale(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: UpdateLocaleDto,
  ) {
    await this.usersService.setLocale(user._id, dto.locale);
    return { locale: dto.locale };
  }

  // 1-9C — source unique et fiable des droits de l'organisation COURANTE
  // pour le frontend (jamais `User.role`, jamais un décodage JWT côté
  // client). Données exclusivement depuis `request.organizationContext`
  // (branché par `OrganizationGuard`, aucune résolution/lookup ici).
  //
  // 1-14C.1 : accessible avec un JWT limité ou un abonnement inactif (état
  // d'accès). Les permissions restent les permissions RÉELLES ; `access`
  // porte l'état commercial : un succès de cette route ne signifie PAS que
  // le commerce est accessible (`access.applicationAccess`), et
  // `access.canRecordSales` est faux dès que l'accès est bloqué, même si
  // `sales.record` figure dans les permissions.
  @Header('Cache-Control', 'no-store')
  @AllowInactiveSubscription('identity')
  @Get('context')
  async context(
    @CurrentUser() user: AuthenticatedPrincipal,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    const effective = effectivePermissions(
      organizationContext.role,
      organizationContext.permissions,
    );
    const access = await this.authService.accessViewFor(
      organizationContext,
      user.accessScope,
    );
    return {
      userId: organizationContext.userId,
      organizationId: organizationContext.organizationId,
      role: organizationContext.role,
      permissions: organizationContext.permissions,
      effectivePermissions: [...effective],
      access: {
        ...access,
        tokenScope: user.accessScope,
        canRecordSales:
          access.applicationAccess && effective.has('sales.record'),
      },
    };
  }
}
