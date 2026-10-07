import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EmailVerificationModule } from '../email-verification/email-verification.module';
import {
  Organization,
  OrganizationSchema,
} from '../organizations/schemas/organization.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import {
  SupportRequest,
  SupportRequestSchema,
} from './schemas/support-request.schema';
import { SUPPORT_CLOCK, type SupportClock } from './support-constants';
import { SupportRequestThrottlerGuard } from './support-rate-limiting';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';

const systemClock: SupportClock = () => new Date();

/**
 * 1-16C.1 — Assistance. Réutilise l'unique expéditeur `EMAIL_SENDER`
 * (Resend en production, remplacé dans les tests). Horloge injectable,
 * remplacée UNIQUEMENT par les tests (`overrideProvider`).
 */
@Module({
  imports: [
    EmailVerificationModule,
    MongooseModule.forFeature([
      { name: SupportRequest.name, schema: SupportRequestSchema },
      { name: User.name, schema: UserSchema },
      { name: Organization.name, schema: OrganizationSchema },
    ]),
  ],
  controllers: [SupportController],
  providers: [
    SupportService,
    SupportRequestThrottlerGuard,
    { provide: SUPPORT_CLOCK, useValue: systemClock },
  ],
})
export class SupportModule {}
