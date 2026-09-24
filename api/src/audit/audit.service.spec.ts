import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { AuditService } from './audit.service';
import { AuditLog, AuditAction } from './schemas/audit-log.schema';

const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const PRODUCT_ID = '112233445566778899001122';
const ACTOR_ID = '99887766554433221100aabb';

/**
 * AuditService — l'organisation est OBLIGATOIRE : elle est écrite dans le
 * document et jamais déduite. `organizationId` est le PREMIER argument, pas
 * une option : un appelant sans org serveur fiable ne peut plus appeler.
 */
describe('AuditService — écriture tenant obligatoire', () => {
  let service: AuditService;
  let auditModel: { create: jest.Mock; find: jest.Mock };

  beforeEach(async () => {
    auditModel = {
      create: jest.fn().mockResolvedValue([]),
      // `findByProduct` utilise `find(...).populate(...).sort(...).exec()` :
      find: jest.fn(() => ({
        populate: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      })),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: getModelToken(AuditLog.name), useValue: auditModel },
      ],
    }).compile();
    service = module.get(AuditService);
  });

  it('écrit l’organizationId SERVEUR (1er argument) dans le document d’audit', async () => {
    await service.log(ORG_A, PRODUCT_ID, AuditAction.CREATED, ACTOR_ID, {
      name: 'X',
    });

    expect(auditModel.create).toHaveBeenCalledTimes(1);
    const [docs, opts] = auditModel.create.mock.calls[0];
    const doc = (docs as Record<string, unknown>[])[0];
    // l'org est écrite en ObjectId, jamais omise :
    expect(String(doc.organizationId)).toBe(ORG_A);
    expect(doc.organizationId).toBeInstanceOf(Types.ObjectId);
    // `create([doc], { session })` : overload en tableau, session nulle par défaut.
    expect(opts).toEqual({ session: null });
    expect(String(doc.productId)).toBe(PRODUCT_ID);
    expect(doc.action).toBe(AuditAction.CREATED);
    expect(String(doc.actorId)).toBe(ACTOR_ID);
  });

  it('transmet la MÊME session à l’écriture quand une session est fournie', async () => {
    const session = { endSession: jest.fn() };
    await service.log(
      ORG_A,
      PRODUCT_ID,
      AuditAction.SOLD,
      ACTOR_ID,
      { saleId: '000000000000000000000000' },
      session,
    );

    const opts = auditModel.create.mock.calls[0][1] as { session: unknown };
    expect(opts.session).toBe(session);
    // l'org reste écrite :
    const doc = (
      auditModel.create.mock.calls[0][0] as Record<string, unknown>[]
    )[0];
    expect(String(doc.organizationId)).toBe(ORG_A);
  });

  it('accepte un ObjectId pour productId/actorId et l’org reste l’argument d’origine', async () => {
    await service.log(
      ORG_A,
      new Types.ObjectId(PRODUCT_ID),
      AuditAction.SOLD,
      new Types.ObjectId(ACTOR_ID),
      {},
    );

    const doc = (
      auditModel.create.mock.calls[0][0] as Record<string, unknown>[]
    )[0];
    expect(String(doc.organizationId)).toBe(ORG_A);
    expect(String(doc.productId)).toBe(PRODUCT_ID);
    expect(String(doc.actorId)).toBe(ACTOR_ID);
  });
});
