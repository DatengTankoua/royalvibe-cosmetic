import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  LEGAL_ARCHIVE,
  LEGAL_CLOCK,
  LegalAcceptanceService,
  type LegalClock,
} from './legal-acceptance.service';
import { LegalArchive } from './legal-documents';
import { LegalController } from './legal.controller';
import {
  LegalAcceptance,
  LegalAcceptanceSchema,
  LegalDocumentVersion,
  LegalDocumentVersionSchema,
} from './schemas/legal-acceptance.schema';

const systemClock: LegalClock = () => new Date();

/**
 * 1-16C.2 — Acceptation versionnée des conditions. Module feuille (aucune
 * dépendance vers Auth ni Organizations) : importé par ces modules pour
 * enregistrer la preuve dans LEUR transaction. Horloge et archive
 * injectables, remplacées UNIQUEMENT par les tests.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LegalAcceptance.name, schema: LegalAcceptanceSchema },
      { name: LegalDocumentVersion.name, schema: LegalDocumentVersionSchema },
    ]),
  ],
  controllers: [LegalController],
  providers: [
    LegalAcceptanceService,
    { provide: LEGAL_CLOCK, useValue: systemClock },
    { provide: LEGAL_ARCHIVE, useFactory: () => new LegalArchive() },
  ],
  exports: [LegalAcceptanceService],
})
export class LegalModule {}
