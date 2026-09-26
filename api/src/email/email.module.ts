import { Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { ResendEmailService } from './resend-email.service';

@Module({
  providers: [{ provide: EmailService, useClass: ResendEmailService }],
  exports: [EmailService],
})
export class EmailModule {}
