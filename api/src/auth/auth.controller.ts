import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { OrganizationsService } from '../organizations/organizations.service';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import { effectivePermissions } from '../organizations/permissions';
import { AuthThrottlerGuard } from '../common/auth-rate-limiting';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { SwitchOrganizationDto } from './dto/switch-organization.dto';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { Public } from './decorators/public.decorator';
import { SkipOrganizationContext } from './decorators/skip-organization-context.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { CurrentOrganization } from './decorators/current-organization.decorator';
import { User } from '../users/schemas/user.schema';
import type { AuthenticatedPrincipal } from './strategies/jwt.strategy';
import { EmailVerificationService } from '../email-verification/email-verification.service';
import { EmailVerificationAddressThrottlerGuard } from '../email-verification/email-verification-rate-limiting';
import {
  ConfirmEmailVerificationDto,
  RequestEmailVerificationDto,
} from '../email-verification/email-verification.dto';
import { PasswordResetService } from '../password-reset/password-reset.service';
import { PasswordResetAddressThrottlerGuard } from '../password-reset/password-reset-rate-limiting';
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

// `AuthThrottlerGuard` (login/register/accept-invitation) trace par IP ;
// exclusion explicite de la fenêtre `invitation-create` (1-10B, tracker
// utilisateur+organisation, sans rapport avec ces routes publiques) —
// jamais l'inverse (`OrganizationsController` exclut symétriquement les
// fenêtres `login-short`/`login-long`).
@SkipThrottle({ 'invitation-create': true })
@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private organizationsService: OrganizationsService,
    private emailVerificationService: EmailVerificationService,
    private passwordResetService: PasswordResetService,
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
    return this.authService.register(dto);
  }

  // Garde de rate limiting (0B.6) : applicée UNIQUEMENT à /auth/login
  // (jamais en garde globale), avant la logique de login.
  @UseGuards(AuthThrottlerGuard)
  @Public()
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }
  // 1-6B.2 : publique et rate-limitée, INDÉPENDANTE de
  // PUBLIC_REGISTRATION_ENABLED (une invitation valide EST l'autorisation).
  // 200 explicite (pas de ressource "créée" au sens REST du POST par défaut).
  @HttpCode(200)
  @UseGuards(AuthThrottlerGuard)
  @Public()
  @Post('invitations/accept')
  acceptInvitation(@Body() dto: AcceptInvitationDto) {
    // 1-13A : acceptation puis envoi éventuel du lien de vérification.
    return this.authService.acceptInvitation(dto);
  }

  // 1-13A : (ré)envoi public du lien de vérification. Limité par IP
  // (`AuthThrottlerGuard`, compteur propre à cette route) ET par adresse
  // normalisée (clé SHA-256). Réponse neutre : compte inexistant, déjà
  // vérifié, en cooldown ou échec fournisseur répondent à l'identique ;
  // l'envoi n'est pas attendu (aucun écart de temps selon le compte).
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthThrottlerGuard, EmailVerificationAddressThrottlerGuard)
  @Public()
  @Post('email-verification/request')
  async requestEmailVerification(@Body() dto: RequestEmailVerificationDto) {
    const { delivery } = await this.emailVerificationService.requestByEmail(
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

  // 1-13B : demande de réinitialisation. Limitée par IP (compteur propre à
  // la route) ET par adresse normalisée (namespace distinct). Réponse
  // neutre ; recherche du compte et envoi après la réponse.
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthThrottlerGuard, PasswordResetAddressThrottlerGuard)
  @Public()
  @Post('password-reset/request')
  requestPasswordReset(@Body() dto: RequestPasswordResetDto) {
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
  @HttpCode(200)
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
    );
  }

  // 1-9B : organisations actives de l'utilisateur courant (userId
  // exclusivement du JWT) — alimente le sélecteur de switch frontend.
  // @SkipOrganizationContext : doit rester listable même si l'organisation
  // COURANTE du JWT est devenue inactive.
  @SkipOrganizationContext()
  @Get('organizations')
  organizations(@CurrentUser() user: User) {
    return this.organizationsService.listActiveOrganizations(
      user._id.toString(),
    );
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedPrincipal) {
    // 1-13B : champs explicites — la version de session reste interne.
    return {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId,
    };
  }

  // 1-9C — source unique et fiable des droits de l'organisation COURANTE
  // pour le frontend (jamais `User.role`, jamais un décodage JWT côté
  // client). Données exclusivement depuis `request.organizationContext`
  // (branché par `OrganizationGuard`, aucune résolution/lookup ici).
  @Get('context')
  context(
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return {
      userId: organizationContext.userId,
      organizationId: organizationContext.organizationId,
      role: organizationContext.role,
      permissions: organizationContext.permissions,
      effectivePermissions: [
        ...effectivePermissions(
          organizationContext.role,
          organizationContext.permissions,
        ),
      ],
    };
  }
}
