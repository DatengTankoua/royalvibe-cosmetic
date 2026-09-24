import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthThrottlerGuard } from '../common/auth-rate-limiting';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { SwitchOrganizationDto } from './dto/switch-organization.dto';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';

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

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

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

  // 200 explicite : le switch répond un nouveau JWT (le POST par défaut
  // NestJS répond 201 — le conserver ici serait trompeur).
  @HttpCode(200)
  @Post('switch-organization')
  switchOrganization(
    @CurrentUser() user: User,
    @Body() dto: SwitchOrganizationDto,
  ) {
    // Le sub provient de l'utilisateur authentifié (JWT) — jamais du body.
    return this.authService.switchOrganization(user._id.toString(), dto);
  }

  @Get('me')
  me(@CurrentUser() user: User) {
    return user;
  }
}
