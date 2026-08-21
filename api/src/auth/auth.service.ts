import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { UserDocument } from '../users/schemas/user.schema';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
  ) {}

  async register(
    dto: RegisterDto,
  ): Promise<{ access_token: string; user: Omit<UserDocument, 'password'> }> {
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

    const token = this.sign(user);
    return { access_token: token, user: this.sanitize(user) };
  }

  async login(
    dto: LoginDto,
  ): Promise<{ access_token: string; user: Omit<UserDocument, 'password'> }> {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user)
      throw new UnauthorizedException('Email ou mot de passe incorrect!');

    const valid = await bcrypt.compare(dto.password, user.password);
    if (!valid)
      throw new UnauthorizedException('Email ou mot de passe incorrect!');

    const token = this.sign(user);
    return { access_token: token, user: this.sanitize(user) };
  }

  private sign(user: UserDocument): string {
    return this.jwtService.sign({
      sub: user._id.toString(),
      email: user.email,
      role: user.role,
    });
  }

  private sanitize(user: UserDocument): Omit<UserDocument, 'password'> {
    const obj = user.toObject();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password: _p, ...rest } = obj;
    return rest as Omit<UserDocument, 'password'>;
  }
}
