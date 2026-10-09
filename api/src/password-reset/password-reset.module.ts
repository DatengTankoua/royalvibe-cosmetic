import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from '../users/schemas/user.schema';
import { EmailVerificationModule } from '../email-verification/email-verification.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { PasswordResetService } from './password-reset.service';

/**
 * 1-13B — Réinitialisation du mot de passe. Réutilise l'UNIQUE
 * `EMAIL_SENDER` (EmailVerificationModule) et le registre des sockets
 * (OrganizationsModule) — aucune dépendance vers AuthModule (pas de cycle).
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
    EmailVerificationModule,
    OrganizationsModule,
  ],
  providers: [PasswordResetService],
  exports: [PasswordResetService],
})
export class PasswordResetModule {}
