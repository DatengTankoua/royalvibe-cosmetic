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
});
