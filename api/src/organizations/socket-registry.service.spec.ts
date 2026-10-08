import { SocketRegistryService } from './socket-registry.service';

const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ORG_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const USER_A = '111111111111111111111111';
const USER_B = '222222222222222222222222';

function makeSocket() {
  return { disconnect: jest.fn() };
}

describe('SocketRegistryService (1-7C)', () => {
  let registry: SocketRegistryService;

  beforeEach(() => {
    registry = new SocketRegistryService();
  });

  it('disconnectMember sans socket connue est un no-op (aucune erreur)', () => {
    expect(() => registry.disconnectMember(ORG_A, USER_A)).not.toThrow();
  });

  it('déconnecte TOUTES les sockets enregistrées pour org+user (multi-appareils)', () => {
    const s1 = makeSocket();
    const s2 = makeSocket();
    registry.register(ORG_A, USER_A, s1 as never);
    registry.register(ORG_A, USER_A, s2 as never);

    registry.disconnectMember(ORG_A, USER_A);

    expect(s1.disconnect).toHaveBeenCalledWith(true);
    expect(s2.disconnect).toHaveBeenCalledWith(true);
  });

  it('ne déconnecte JAMAIS les sockets d’un autre membre ou d’une autre organisation', () => {
    const target = makeSocket();
    const otherUser = makeSocket();
    const otherOrg = makeSocket();
    registry.register(ORG_A, USER_A, target as never);
    registry.register(ORG_A, USER_B, otherUser as never);
    registry.register(ORG_B, USER_A, otherOrg as never);

    registry.disconnectMember(ORG_A, USER_A);

    expect(target.disconnect).toHaveBeenCalledWith(true);
    expect(otherUser.disconnect).not.toHaveBeenCalled();
    expect(otherOrg.disconnect).not.toHaveBeenCalled();
  });

  it('unregister retire une socket précise ; les autres restent enregistrées', () => {
    const s1 = makeSocket();
    const s2 = makeSocket();
    registry.register(ORG_A, USER_A, s1 as never);
    registry.register(ORG_A, USER_A, s2 as never);

    registry.unregister(ORG_A, USER_A, s1 as never);
    registry.disconnectMember(ORG_A, USER_A);

    expect(s1.disconnect).not.toHaveBeenCalled();
    expect(s2.disconnect).toHaveBeenCalledWith(true);
  });

  it('unregister sur une clé inconnue est un no-op (aucune erreur)', () => {
    const s1 = makeSocket();
    expect(() => registry.unregister(ORG_A, USER_A, s1 as never)).not.toThrow();
  });

  it('après disconnectMember, une reconnexion (nouveau register) fonctionne à nouveau', () => {
    const s1 = makeSocket();
    registry.register(ORG_A, USER_A, s1 as never);
    registry.disconnectMember(ORG_A, USER_A);

    const s2 = makeSocket();
    registry.register(ORG_A, USER_A, s2 as never);
    registry.disconnectMember(ORG_A, USER_A);

    expect(s2.disconnect).toHaveBeenCalledWith(true);
  });
  describe('disconnectUserSessionsBefore (1-13B)', () => {
    const versioned = (authVersion?: number) => ({
      disconnect: jest.fn(),
      data: authVersion === undefined ? {} : { authVersion },
    });

    it('ferme les sockets antérieurs de l’utilisateur dans TOUTES ses organisations, garde la nouvelle version et les autres utilisateurs', () => {
      const oldA = versioned(0);
      const legacyB = versioned(); // handshake sans version → 0
      const fresh = versioned(1);
      const other = versioned(0);
      registry.register(ORG_A, USER_A, oldA as never);
      registry.register(ORG_B, USER_A, legacyB as never);
      registry.register(ORG_A, USER_A, fresh as never);
      registry.register(ORG_A, USER_B, other as never);

      expect(registry.disconnectUserSessionsBefore(USER_A, 1)).toBe(2);

      expect(oldA.disconnect).toHaveBeenCalledWith(true);
      expect(legacyB.disconnect).toHaveBeenCalledWith(true);
      expect(fresh.disconnect).not.toHaveBeenCalled();
      expect(other.disconnect).not.toHaveBeenCalled();
      // Seul le socket à jour reste enregistré pour USER_A.
      registry.disconnectMember(ORG_A, USER_A);
      expect(fresh.disconnect).toHaveBeenCalledTimes(1);
      registry.disconnectMember(ORG_B, USER_A);
      expect(legacyB.disconnect).toHaveBeenCalledTimes(1);
    });

    it('aucun socket connu → 0, aucune erreur', () => {
      expect(registry.disconnectUserSessionsBefore(USER_A, 3)).toBe(0);
    });
  });
  describe('signalOrganization (1-15C)', () => {
    it('sans passerelle branchée : aucun effet, aucune erreur', () => {
      const registry = new SocketRegistryService();
      expect(() =>
        registry.signalOrganization('org-a', 'members:changed'),
      ).not.toThrow();
    });

    it('délègue à la passerelle : organisation, événement, payload VIDE', () => {
      const registry = new SocketRegistryService();
      const emitter = jest.fn();
      registry.attachOrganizationEmitter(emitter);
      registry.signalOrganization('org-a', 'invitations:changed');
      registry.signalOrganization('org-a', 'organization:updated');
      expect(emitter.mock.calls).toEqual([
        ['org-a', 'invitations:changed', {}],
        ['org-a', 'organization:updated', {}],
      ]);
    });

    it('panne d’émission : jamais propagée (best effort)', () => {
      const registry = new SocketRegistryService();
      registry.attachOrganizationEmitter(() => {
        throw new Error('socket indisponible');
      });
      expect(() =>
        registry.signalOrganization('org-a', 'members:changed'),
      ).not.toThrow();
    });
  });
});
