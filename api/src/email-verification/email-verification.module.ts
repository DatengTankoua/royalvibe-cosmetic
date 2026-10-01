import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from '../users/schemas/user.schema';
import { EMAIL_SENDER } from './email-sender';
import { ResendEmailSender } from './resend-email-sender';
import { EmailVerificationService } from './email-verification.service';
import { EmailVerificationAddressThrottlerGuard } from './email-verification-rate-limiting';

/**
 * 1-13A — Vérification des emails. `EMAIL_SENDER` = Resend en production ;
 * les tests le remplacent par `overrideProvider(EMAIL_SENDER)`.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
  ],
  providers: [
    { provide: EMAIL_SENDER, useClass: ResendEmailSender },
    EmailVerificationService,
    EmailVerificationAddressThrottlerGuard,
  ],
  exports: [EmailVerificationService, EmailVerificationAddressThrottlerGuard],
})
export class EmailVerificationModule {}
