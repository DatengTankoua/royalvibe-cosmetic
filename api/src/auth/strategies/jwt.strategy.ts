import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../../users/users.service';
import { UserDocument } from '../../users/schemas/user.schema';

interface JwtPayload {
  sub: string;
  orgId: string;
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
   * Le rôle ne vient JAMAIS du JWT : `request.user` est le document User
   * chargé de la base (RôlesGuard le lit directement). `sub`/`orgId` sont
   * validés STRICTEMENT (string + 24 hex, jamais de cast) AVANT toute
   * requête : une valeur non canonique ne doit jamais produire un
   * `CastError` 500 (401 contrôlée).
   */
  async validate(payload: JwtPayload): Promise<UserDocument> {
    if (!isStrictObjectId(payload?.sub) || !isStrictObjectId(payload?.orgId)) {
      throw new UnauthorizedException();
    }

    const user = await this.usersService.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException();
    }
    return user;
  }
}
