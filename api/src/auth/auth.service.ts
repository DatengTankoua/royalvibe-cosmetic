import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { SwitchOrganizationDto } from './dto/switch-organization.dto';
import { UserDocument } from '../users/schemas/user.schema';
import {
  ORGANIZATION_ACCESS_DENIED,
  OrganizationsService,
} from '../organizations/organizations.service';

export interface SelectableOrganization {
  organizationId: string;
  name: string;
}

export type LoginResult =
  | { access_token: string; user: Omit<UserDocument, 'password'> }
  | {
      organizationSelectionRequired: true;
      organizations: SelectableOrganization[];
    };

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private organizationsService: OrganizationsService,
  ) {}

  register(
    dto: RegisterDto,
  ): Promise<{ user: Omit<UserDocument, 'password'> }> {
    return this.registerUser(dto);
  }

  private async registerUser(
    dto: RegisterDto,
  ): Promise<{ user: Omit<UserDocument, 'password'> }> {
    const existing = await this.usersService.findByEmail(dto.email);
    if (existing)
      throw new BadRequestException(
        'Si cette adresse est valide, un email de confirmation a déjà été envoyé.',
      );

    const hashed = await bcrypt.hash(dto.password, 10);
    const user = await this.usersService.create({
      name: dto.name,
      email: dto.email,
      password: hashed,
    });

    // Pas de JWT à l'inscription : l'utilisateur n'appartient encore à
    // aucune organisation (le token orgId est obtenu au login).
    return { user: this.sanitize(user) };
  }

  async login(dto: LoginDto): Promise<LoginResult> {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user)
      throw new UnauthorizedException('Email ou mot de passe incorrect!');

    const valid = await bcrypt.compare(dto.password, user.password);
    if (!valid)
      throw new UnauthorizedException('Email ou mot de passe incorrect!');

    const userId = user._id.toString();

    // Choix explicite : validation serveur complète (membership + org
    // actives), puis JWT. Tout refus est uniforme (jamais de détail).
    if (dto.organizationId) {
      const context = await this.organizationsService.resolveActiveContext(
        userId,
        dto.organizationId,
      );
      return {
        access_token: this.sign(userId, context.organizationId),
        user: this.sanitize(user),
      };
    }

    const organizations =
      await this.organizationsService.listActiveOrganizations(userId);

    // Aucune organisation active : même refus uniforme (l'organisation
    // ciblée par le login n'existe pas pour cet utilisateur).
    if (organizations.length === 0) {
      throw this.organizationAccessDenied();
    }

    if (organizations.length === 1) {
      return {
        access_token: this.sign(userId, organizations[0].organizationId),
        user: this.sanitize(user),
      };
    }

    // Plusieurs organisations : le client doit choisir. Aucune donnée
    // sensible (permissions, membershipId), liste triée par nom
    // (ordre déterministe).
    return {
      organizationSelectionRequired: true,
      organizations: [...organizations].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    };
  }

  /**
   * Switch d'organisation : le `userId` provient EXCLUSIVEMENT de l'appelant
   * authentifié (sub du JWT) — jamais d'un corps de requête. Aucune
   * écriture persistante : seul le JWT (orgId) change.
   */
  async switchOrganization(
    userId: string,
    dto: SwitchOrganizationDto,
  ): Promise<{ access_token: string }> {
    const context = await this.organizationsService.resolveActiveContext(
      userId,
      dto.organizationId,
    );
    return { access_token: this.sign(userId, context.organizationId) };
  }

  private sign(userId: string, organizationId: string): string {
    // Payload métier minimal : plus d'`email` ni de `role` — le rôle
    // vient exclusivement du document User chargé par la stratégie.
    return this.jwtService.sign({ sub: userId, orgId: organizationId });
  }

  // Refus uniforme : ne révèle ni l'existence, ni le statut (suspension/
  // révocation) d'une organisation ou d'une membership.
  private organizationAccessDenied(): ForbiddenException {
    return new ForbiddenException({
      code: ORGANIZATION_ACCESS_DENIED,
      message: "Accès à l'organisation refusé.",
    });
  }

  private sanitize(user: UserDocument): Omit<UserDocument, 'password'> {
    const obj = user.toObject();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password: _p, ...rest } = obj;
    return rest as Omit<UserDocument, 'password'>;
  }
}
