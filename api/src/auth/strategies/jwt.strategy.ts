import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { UsersService } from '../../users/users.service';
import { UserRole } from '../../users/schemas/user.schema';
import {
  EMAIL_NOT_VERIFIED,
  EMAIL_NOT_VERIFIED_MESSAGE,
} from '../../email-verification/email-verification.service';
import {
  SESSION_REVOKED,
  SESSION_REVOKED_MESSAGE,
  currentSessionVersion,
  isSessionCurrent,
} from '../session-version';
import {
  AccessScope,
  accessScopeFromClaims,
} from '../../subscriptions/subscription-access';

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
  /**
   * 1-13B : version de session VALIDÉE de ce JWT (claim `ver`, égal à la
   * base au moment de la validation). Sert à signer un JWT dérivé (switch)
   * sans jamais l'élever à une version plus récente. Jamais renvoyée au client.
   */
  sessionVersion: number;
  /**
   * 1-14C.1 : portée SIGNÉE du JWT (`app` | `subscription_limited`). Claim
   * absent (JWT historique) = `app` ; présent mais invalide → 401.
   */
  accessScope: AccessScope;
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
    // 1-14C.1 : portée validée AVANT toute requête — aucune conversion
    // permissive d'une valeur inconnue ou mal typée.
    const accessScope = accessScopeFromClaims(
      payload as unknown as Record<string, unknown>,
    );
    if (accessScope === null) {
      throw new UnauthorizedException();
    }

    const user = await this.usersService.findByIdForAuth(payload.sub);
    if (!user) {
      throw new UnauthorizedException();
    }
    // 1-13B : version de session relue à CHAQUE requête — un JWT antérieur à
    // une réinitialisation de mot de passe est refusé, toute organisation.
    if (
      !isSessionCurrent(payload as unknown as Record<string, unknown>, user)
    ) {
      throw new UnauthorizedException({
        code: SESSION_REVOKED,
        message: SESSION_REVOKED_MESSAGE,
      });
    }
    // 1-13A : relu à CHAQUE requête — un JWT émis avant la vérification
    // obligatoire (ou pour un compte non vérifié) ne donne aucun accès.
    if (!user.emailVerifiedAt) {
      throw new UnauthorizedException({
        code: EMAIL_NOT_VERIFIED,
        message: EMAIL_NOT_VERIFIED_MESSAGE,
      });
    }

    // Nouvel objet principal : le document Mongoose est LU (pas muté).
    const principal: AuthenticatedPrincipal = {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      organizationId: payload.orgId,
      sessionVersion: currentSessionVersion(user),
      accessScope,
    };
    return principal;
  }
}
