import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { UsersService } from '../../users/users.service';
import { UserRole } from '../../users/schemas/user.schema';

interface JwtPayload {
  sub: string;
  orgId: string;
}

/**
 * Principal porté sur `request.user` (1-3B.2) — NOUVEL objet explicite,
 * jamais un document Mongoose muté. Champ `organizationId` issu EXCLUSIVEMENT
 * du JWT vérifié (`orgId`), jamais du client. `password` n'appartient jamais
 * à ce principal (jamais chargé non plus : `select:false`).
 */
export interface AuthenticatedPrincipal {
  _id: Types.ObjectId;
  name: string;
  email: string;
  role: UserRole;
  organizationId: string;
}

// ObjectId canonique : une CHAÎNE strictement de 24 caractères hexadécimaux.
// Refuse nombre/objet/tableau, chaîne vide, chaîne de 12 caractères ou 24
// caractères contenant un non-hex. `isValidObjectId()` n'est PAS utilisé :
// son cast est trop permissif (plusieurs formes non-canoniques acceptées).
const isStrictObjectId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-fA-F]{24}$/.test(value);

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  /**
   * Le rôle ne vient JAMAIS du JWT : `name`/`email`/`role` sont lus du
   * document User chargé de la base (RôlesGuard lit `role` ; les contrôleurs
   * lisent `_id`). `sub`/`orgId` sont validés STRICTEMENT (string + 24 hex,
   * jamais de cast) AVANT toute requête : une valeur non canonique ne doit
   * jamais produire un `CastError` 500 (401 contrôlée).
   *
   * Retourne un NOUVEAU principal explicite (jamais un document Mongoose
   * muté) : les champs serveur réellement requis par le contrat (`_id`,
   * `name`, `email`, `role`) plus `organizationId` = le claim `orgId` vérifié
   * du JWT, exclusivement. `password` n'appartient jamais à ce principal.
   */
  async validate(payload: JwtPayload): Promise<AuthenticatedPrincipal> {
    if (!isStrictObjectId(payload?.sub) || !isStrictObjectId(payload?.orgId)) {
      throw new UnauthorizedException();
    }

    const user = await this.usersService.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException();
    }

    // Nouvel objet principal : le document Mongoose est LU (pas muté).
    const principal: AuthenticatedPrincipal = {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      organizationId: payload.orgId,
    };
    return principal;
  }
}
