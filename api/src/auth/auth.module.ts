import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    UsersModule,
    PassportModule,
    // Instance du JwtModule (secret `JWT_SECRET`, `signOptions.expiresIn: '7d'`)
    // — MÊME configuration que l'auth HTTP : le handshake Socket.IO (0B.3)
    // vérifie les tokens avec cette instance exacte.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: '7d' },
      }),
    }),
  ],
  providers: [
    AuthService,
    JwtStrategy,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  controllers: [AuthController],
  // `JwtModule` (classe, pas l'objet dynamique de registerAsync) : NestJS
  // autorise l'export d'un module importé quand on exporte sa CLASSE de
  // metatype (validateExportedProvider, @nestjs/core 11.1.28) — c'est cette
  // classe qui est stockée comme metatype de l'import dynamique, exactement
  // comme pour `forRoot()` (d'où `exports: [ConfigModule]` après un
  // forRoot). L'export de la classe rend `JwtService` transitive aux
  // importateurs de `AuthModule` (EventsModule → Gateway Socket.IO) ;
  // exporter `JwtService` lui-même lèverait `UnknownExportException`, car ce
  // n'est pas un provider local de ce module.
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
