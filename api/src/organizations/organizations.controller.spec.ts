import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { ResolvedOrganizationContext } from './organizations.service';
import { OrganizationRole } from './permissions';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import {
  InvitationCreateThrottlerGuard,
  createInvitationThrottlerWindow,
} from '../common/invitation-rate-limiting';
import type { User } from '../users/schemas/user.schema';

// Clé interne de `@nestjs/throttler` (`THROTTLER_SKIP`, non ré-exportée par
// l'index public du package — jamais d'import profond dans `dist/`).
const THROTTLER_SKIP = 'THROTTLER:SKIP';

const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ORG_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const INVITATION_ID = '223344556677889900112233';

function makeContext(
  org: string,
  role: OrganizationRole,
): ResolvedOrganizationContext {
  return {
    userId: '111111111111111111111111',
    organizationId: org,
    membershipId: '222222222222222222222222',
    role,
    permissions: [],
  };
}

const user = { _id: new Types.ObjectId('eeeeeeeeeeeeeeeeeeeeeeee') } as User;

/**
 * OrganizationsController (1-7B) — autorisation `members.invite` déléguée
 * à `PermissionGuard` (global) via `@RequirePermissions`, testée
 * génériquement en 1-7A. Ce spec vérifie UNIQUEMENT : (1) la métadonnée
 * exacte portée par le contrôleur, (2) que `organizationId` provient
 * EXCLUSIVEMENT de `@CurrentOrganization()`, jamais du DTO/body.
 */
describe('OrganizationsController — invitations (1-7B)', () => {
  let controller: OrganizationsController;

  const serviceStub = {
    createInvitation: jest.fn(),
    listInvitations: jest.fn(),
    revokeInvitation: jest.fn(),
  };

  beforeEach(async () => {
    for (const key of Object.keys(serviceStub)) {
      (serviceStub as Record<string, jest.Mock>)[key].mockReset();
    }
    const module: TestingModule = await Test.createTestingModule({
      // 1-10B : ThrottlerModule réel (même convention que
      // auth.controller.spec.ts pour AuthThrottlerGuard) — seule la
      // résolution DI de `@UseGuards` importe ici (jamais exécuté,
      // `controller.create()` est appelé directement, hors pipeline
      // HTTP/gardes).
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [createInvitationThrottlerWindow()],
        }),
      ],
      controllers: [OrganizationsController],
      providers: [
        { provide: OrganizationsService, useValue: serviceStub },
        InvitationCreateThrottlerGuard,
      ],
    }).compile();
    controller = module.get(OrganizationsController);
  });

  const ownerCtx = makeContext(ORG_A, OrganizationRole.OWNER);
  const dto = { email: 'invite@example.com', role: OrganizationRole.ADMIN };

  it('@RequirePermissions(members.invite) est déclarée au niveau du contrôleur (les 3 routes)', () => {
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, OrganizationsController),
    ).toEqual(['members.invite']);
  });

  // 1-10B : la fenêtre `invitation-create` (tracker user+org) ne doit
  // jamais s'appliquer aux fenêtres `login-short`/`login-long` du garde
  // partagé, et réciproquement — vérifie l'exclusion déclarée sur `create`.
  it('create exclut explicitement les fenêtres login-short/login-long (1-10B)', () => {
    // Cast en `Record<string, unknown>` : lecture de métadonnées sur la
    // référence de fonction, jamais un appel — évite le faux positif
    // `unbound-method` (qui suppose un besoin de binding `this`).
    const proto = OrganizationsController.prototype as unknown as Record<
      string,
      unknown
    >;
    const createHandler = proto.create;
    const skipLoginShort = Reflect.getMetadata(
      THROTTLER_SKIP + 'login-short',
      createHandler,
    );
    const skipLoginLong = Reflect.getMetadata(
      THROTTLER_SKIP + 'login-long',
      createHandler,
    );
    expect(skipLoginShort).toBe(true);
    expect(skipLoginLong).toBe(true);
  });

  describe('create (POST /organizations/invitations)', () => {
    it('transmet organizationId du CONTEXTE + invitedById du USER courant', async () => {
      serviceStub.createInvitation.mockResolvedValue({
        invitation: {},
        token: 't',
      });
      await controller.create(dto, user, ownerCtx);
      expect(serviceStub.createInvitation).toHaveBeenCalledTimes(1);
      expect(serviceStub.createInvitation).toHaveBeenCalledWith(
        ORG_A,
        'eeeeeeeeeeeeeeeeeeeeeeee',
        dto,
      );
    });
  });

  describe('findAll (GET /organizations/invitations)', () => {
    it('liste UNIQUEMENT l’organisation du contexte', async () => {
      serviceStub.listInvitations.mockResolvedValue([]);
      await controller.findAll(ownerCtx);
      expect(serviceStub.listInvitations).toHaveBeenCalledWith(ORG_A);
    });

    it('org B falsifiée sans effet : seul le contexte réel (A) compte', async () => {
      serviceStub.listInvitations.mockResolvedValue([]);
      await controller.findAll(makeContext(ORG_A, OrganizationRole.OWNER));
      expect(serviceStub.listInvitations).not.toHaveBeenCalledWith(ORG_B);
    });
  });

  describe('revoke (POST /organizations/invitations/:id/revoke)', () => {
    it('transmet organizationId du contexte + id du paramètre', async () => {
      serviceStub.revokeInvitation.mockResolvedValue({});
      await controller.revoke(INVITATION_ID, ownerCtx);
      expect(serviceStub.revokeInvitation).toHaveBeenCalledWith(
        ORG_A,
        INVITATION_ID,
      );
    });
  });
});
