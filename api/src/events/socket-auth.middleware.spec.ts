/**
 * Tests unitaires du middleware Socket.IO (phase 0B.3) — le comportement
 * réel du package Socket.IO (rejet → packet `CONNECT_ERROR`, `socket.data`)
 * est couvert en E2E ; ici on isole la logique du handler, avec `JwtService`
 * et `UsersService` mockés, pour vérifier :
 *
 * - source unique (`socket.handshake.auth.token`),
 * - les refus (absent, vide, non-string, invalide, expiré, signature
 *   incorrecte, payload incomplet, user supprimé) ;
 * - l'acceptation (token valide) + le principal minimal ;
 * - `next()` appelé EXACTEMENT UNE FOIS en tous les cas ;
 * - aucune fuite (`unauthorized` générique ; pas de password, pas de token
 *   dans `socket.data`) ;
 * - **déconnexion à l'expiration du JWT** (timer `unref()` programmé à
 *   `exp`, nettoyé sur `disconnect`) — fake timers.
 *
 * Aucun skip / todo / only.
 */
import {
  SOCKET_AUTH_TOKEN_KEY,
  SocketPrincipal,
  installSocketAuthMiddleware,
  scheduleSocketDisconnectAtExpiry,
} from './socket-auth.middleware';

/** Handle de timer (fake timers : shim sinonjs avec `refed`/`hasRef`/`unref`). */
interface TimerHandle {
  refed?: boolean;
  hasRef?: () => boolean;
}

describe('socket-auth.middleware (installSocketAuthMiddleware)', () => {
  const USER_ID = '0123456789abcdef01234567'; // ObjectId hex valide
  const USER_EMAIL = 'seller@example.com';
  const USER_ROLE = 'seller';
  const VALID_TOKEN = 'valid-jwt-token';

  interface Deps {
    jwtService: { verifyAsync: jest.Mock };
    usersService: { findById: jest.Mock };
    logger: { warn: jest.Mock; error: jest.Mock };
  }

  let deps: Deps;

  /** Socket simulé minimal — la surface lue par le handler + la surface
   * timer (`once`/`off`) appelée par `scheduleSocketDisconnectAtExpiry` à
   * l'acceptation. `disconnect` est espionné (vérifier qu'il n'est PAS
   * appelé dans un chemin de refus). */
  function makeSocket(auth: Record<string, unknown> | undefined) {
    const disconnect = jest.fn();
    return {
      handshake: { auth: auth === undefined ? {} : auth },
      data: {} as Record<string, unknown> & { user?: SocketPrincipal },
      disconnect,
      once: jest.fn(),
      off: jest.fn(),
    };
  }

  function installAndInstall() {
    const use = jest.fn();
    installSocketAuthMiddleware({ use } as never, {
      jwtService: deps.jwtService,
      usersService: deps.usersService,
      logger: deps.logger,
    });
    const middleware = use.mock.calls[0][0] as (
      socket: ReturnType<typeof makeSocket>,
      next: (err?: Error) => void,
    ) => void;
    return { use, middleware };
  }

  async function run(socket: ReturnType<typeof makeSocket>) {
    const { use, middleware } = installAndInstall();
    const next = jest.fn();
    middleware(socket, next);
    // Laisse la promesse interne du handler se résoudre.
    await Promise.resolve();
    await Promise.resolve();
    return { use, next };
  }

  function validUser() {
    return {
      _id: { toString: () => USER_ID },
      email: USER_EMAIL,
      role: USER_ROLE,
    };
  }
  function validPayload(expOverride?: number) {
    return {
      sub: USER_ID,
      email: USER_EMAIL,
      role: USER_ROLE,
      // `exp` futur (number fini) : exigence du middleware — sinon refus.
      exp: expOverride ?? Math.floor(Date.now() / 1000) + 3600,
    };
  }

  beforeEach(() => {
    deps = {
      jwtService: { verifyAsync: jest.fn() },
      usersService: { findById: jest.fn() },
      logger: { warn: jest.fn(), error: jest.fn() },
    };
  });

  it('installe le middleware EXACTEMENT une fois sur le serveur', async () => {
    const user = makeSocket({ [SOCKET_AUTH_TOKEN_KEY]: VALID_TOKEN });
    deps.jwtService.verifyAsync.mockResolvedValue(validPayload());
    deps.usersService.findById.mockResolvedValue(validUser());
    const { use } = await run(user);
    expect(use).toHaveBeenCalledTimes(1);
  });

  it('un token valide est accepté : principal minimal, next() sans erreur', async () => {
    deps.jwtService.verifyAsync.mockResolvedValue(validPayload());
    deps.usersService.findById.mockResolvedValue(validUser());
    const socket = makeSocket({ [SOCKET_AUTH_TOKEN_KEY]: VALID_TOKEN });
    const { next } = await run(socket);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeUndefined();
    expect(socket.data.user).toEqual({
      sub: USER_ID,
      email: USER_EMAIL,
      role: USER_ROLE,
    });
    // Le principal minimal ne contient ni password, ni token, ni _id.
    expect(socket.data.user).not.toHaveProperty('password');
    expect(socket.data.user).not.toHaveProperty('token');
    expect(socket.data.user).not.toHaveProperty('_id');
  });

  it('refuse un token ABSENT (auth = {}) — message générique « unauthorized »', async () => {
    const socket = makeSocket(undefined);
    const { next } = await run(socket);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((next.mock.calls[0][0] as Error).message).toBe('unauthorized');
    expect(socket.data.user).toBeUndefined();
  });

  it('refuse un token VIDE — message générique « unauthorized »', async () => {
    const socket = makeSocket({ [SOCKET_AUTH_TOKEN_KEY]: '' });
    const { next } = await run(socket);
    expect(next).toHaveBeenCalledTimes(1);
    expect((next.mock.calls[0][0] as Error).message).toBe('unauthorized');
  });

  it.each([
    ['objet au lieu de string', { token: 'x' }] as const,
    ['chiffre au lieu de string', 42] as const,
    ['booléen au lieu de string', true] as const,
  ])(
    'refuse un token non-string (%s) — « unauthorized »',
    async (_label, tokenValue) => {
      const socket = makeSocket({
        [SOCKET_AUTH_TOKEN_KEY]: tokenValue,
      });
      const { next } = await run(socket);
      expect(next).toHaveBeenCalledTimes(1);
      expect((next.mock.calls[0][0] as Error).message).toBe('unauthorized');
    },
  );

  it('refuse un token INVALIDE (signature incorrecte / falsifié) — générique', async () => {
    deps.jwtService.verifyAsync.mockRejectedValue(
      new Error('invalid signature'),
    );
    const socket = makeSocket({ [SOCKET_AUTH_TOKEN_KEY]: 'tampered.token' });
    const { next } = await run(socket);
    expect(next).toHaveBeenCalledTimes(1);
    expect((next.mock.calls[0][0] as Error).message).toBe('unauthorized');
    expect(socket.data.user).toBeUndefined();
    // Le message journalisé ne contient ni le token, ni un raison détaillée.
    expect(String(deps.logger.warn.mock.calls.flat().join(' '))).not.toContain(
      'tampered.token',
    );
  });

  it('refuse un token EXPIRÉ — générique (pas de distinction client/expiré)', async () => {
    deps.jwtService.verifyAsync.mockRejectedValue(new Error('jwt expired'));
    const socket = makeSocket({ [SOCKET_AUTH_TOKEN_KEY]: 'expired.token' });
    const { next } = await run(socket);
    expect(next).toHaveBeenCalledTimes(1);
    expect((next.mock.calls[0][0] as Error).message).toBe('unauthorized');
  });

  it('refuse un token signé avec UN AUTRE SECRET — générique', async () => {
    // Même rejet que invalid : aucune révélation de la cause.
    deps.jwtService.verifyAsync.mockRejectedValue(
      new Error('jwt signature is invalid'),
    );
    const socket = makeSocket({ [SOCKET_AUTH_TOKEN_KEY]: 'foreign-signed' });
    const { next } = await run(socket);
    expect(next).toHaveBeenCalledTimes(1);
    expect((next.mock.calls[0][0] as Error).message).toBe('unauthorized');
  });

  it('refuse un payload INCOMPLET (sans `sub`) — générique', async () => {
    deps.jwtService.verifyAsync.mockResolvedValue({
      email: USER_EMAIL,
      role: USER_ROLE,
    });
    const socket = makeSocket({ [SOCKET_AUTH_TOKEN_KEY]: VALID_TOKEN });
    const { next } = await run(socket);
    expect(next).toHaveBeenCalledTimes(1);
    expect((next.mock.calls[0][0] as Error).message).toBe('unauthorized');
  });

  it('refuse un payload INCOMPLET (sans `email`) — générique', async () => {
    deps.jwtService.verifyAsync.mockResolvedValue({
      sub: USER_ID,
      role: USER_ROLE,
    });
    const socket = makeSocket({ [SOCKET_AUTH_TOKEN_KEY]: VALID_TOKEN });
    const { next } = await run(socket);
    expect(next).toHaveBeenCalledTimes(1);
    expect((next.mock.calls[0][0] as Error).message).toBe('unauthorized');
  });

  it('refuse un payload INCOMPLET (sans `role`) — générique', async () => {
    deps.jwtService.verifyAsync.mockResolvedValue({
      sub: USER_ID,
      email: USER_EMAIL,
    });
    const socket = makeSocket({ [SOCKET_AUTH_TOKEN_KEY]: VALID_TOKEN });
    const { next } = await run(socket);
    expect(next).toHaveBeenCalledTimes(1);
    expect((next.mock.calls[0][0] as Error).message).toBe('unauthorized');
  });

  it('refuse un payload dont `sub` n’est pas une string non vide — générique', async () => {
    for (const sub of [42, '', null]) {
      deps = {
        jwtService: {
          verifyAsync: jest.fn().mockResolvedValue({
            sub,
            email: USER_EMAIL,
            role: USER_ROLE,
          }),
        },
        usersService: { findById: jest.fn() },
        logger: { warn: jest.fn(), error: jest.fn() },
      };
      const socket = makeSocket({ [SOCKET_AUTH_TOKEN_KEY]: VALID_TOKEN });
      const { next } = await run(socket);
      expect(next).toHaveBeenCalledTimes(1);
      expect((next.mock.calls[0][0] as Error).message).toBe('unauthorized');
    }
  });

  it('refuse un utilisateur INEXISTANT (supprimé, JWT valide) — générique', async () => {
    deps.jwtService.verifyAsync.mockResolvedValue(validPayload());
    deps.usersService.findById.mockResolvedValue(null);
    const socket = makeSocket({ [SOCKET_AUTH_TOKEN_KEY]: VALID_TOKEN });
    const { next } = await run(socket);
    expect(next).toHaveBeenCalledTimes(1);
    expect((next.mock.calls[0][0] as Error).message).toBe('unauthorized');
    expect(socket.data.user).toBeUndefined();
    // Requête d'existence faite (mêmes politique que JwtStrategy.validate).
    expect(deps.usersService.findById).toHaveBeenCalledTimes(1);
    expect(deps.usersService.findById.mock.calls[0][0]).toBe(USER_ID);
    // Le message client reste générique (pas « user not found »).
    expect(String(deps.logger.warn.mock.calls.flat().join(' '))).not.toContain(
      USER_ID,
    );
  });

  it('réutilise le MÊME JwtService / UsersService (pas de re-implémentation JWT)', async () => {
    deps.jwtService.verifyAsync.mockResolvedValue(validPayload());
    deps.usersService.findById.mockResolvedValue(validUser());
    const socket = makeSocket({ [SOCKET_AUTH_TOKEN_KEY]: VALID_TOKEN });
    const { next } = await run(socket);
    expect(deps.jwtService.verifyAsync).toHaveBeenCalledTimes(1);
    // Le token exact est vérifié (et uniquement via le JwtService fourni).
    expect(deps.jwtService.verifyAsync.mock.calls[0][0]).toBe(VALID_TOKEN);
    expect(deps.usersService.findById).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeUndefined();
  });

  it('`next()` est appelé EXACTEMENT une fois même quand `verifyAsync` lève (garde double-appel)', async () => {
    deps.jwtService.verifyAsync.mockRejectedValue(new Error('boom'));
    const socket = makeSocket({ [SOCKET_AUTH_TOKEN_KEY]: VALID_TOKEN });
    const { next } = await run(socket);
    expect(next).toHaveBeenCalledTimes(1);
    expect((next.mock.calls[0][0] as Error).message).toBe('unauthorized');
  });

  it('n’expose JAMAIS le `password` dans `socket.data.user` (même si le document le porte)', async () => {
    deps.jwtService.verifyAsync.mockResolvedValue(validPayload());
    const secretHash = '$2b$10$abcsecret';
    deps.usersService.findById.mockResolvedValue({
      ...validUser(),
      password: secretHash,
    });
    const socket = makeSocket({ [SOCKET_AUTH_TOKEN_KEY]: VALID_TOKEN });
    await run(socket);
    // Le handler sélectionne explicitement sub/email/role uniquement.
    expect(socket.data.user).toEqual({
      sub: USER_ID,
      email: USER_EMAIL,
      role: USER_ROLE,
    });
    expect(JSON.stringify(socket.data.user)).not.toContain(secretHash);
  });

  describe('refus au handshake quand `exp` du payload vérifié est invalide', () => {
    // 3 familles exigées : (a) `exp` absent, (b) `exp` non-numérique,
    // (c) `exp` ≤ maintenant. Toutes sont REFUSÉES dès le middleware
    // (AVANT `findById`, AVANT toute création de timer) :
    // `next(Error('unauthorized'))` EXACTEMENT une fois, aucun timer,
    // `socket.disconnect` jamais appelé, `socket.data.user` non attaché
    // (→ namespace Socket.IO non établi).
    // `absent = true` ⇒ champ `exp` omis du payload.

    type ExpCase = [label: string, exp: unknown, absent: boolean];
    const expCases: readonly ExpCase[] = [
      ['absent (pas de champ `exp`)', undefined, true],
      ['non-numérique (string)', 'soon', false],
      ['non-numérique (null)', null, false],
      ['non-numérique (NaN)', Number.NaN, false],
      ['non-numérique (Infinity)', Number.POSITIVE_INFINITY, false],
    ];

    /** `exp` dépassée (secondes epoch ≤ maintenant, arrondi entier). */
    const PAST_EXP_S = () => Math.floor(Date.now() / 1000) - 60;

    it.each(expCases)(
      'payload sans `exp` valide (%s) → refus « unauthorized » ; aucun timer ; pas de disconnect',
      async (_label, expValue, absent) => {
        deps.jwtService.verifyAsync.mockResolvedValue(
          absent
            ? { sub: USER_ID, email: USER_EMAIL, role: USER_ROLE }
            : { ...validPayload(), exp: expValue },
        );
        deps.usersService.findById.mockResolvedValue(validUser());
        const socket = makeSocket({ [SOCKET_AUTH_TOKEN_KEY]: VALID_TOKEN });
        const { next } = await run(socket);
        expect(next).toHaveBeenCalledTimes(1);
        expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
        expect((next.mock.calls[0][0] as Error).message).toBe('unauthorized');
        expect(socket.data.user).toBeUndefined();
        // Refus AVANT le timer : `once` (installation du listener de
        // nettoyage) et `disconnect` ne sont JAMAIS appelés (pas de timer).
        expect(socket.once).not.toHaveBeenCalled();
        expect(socket.disconnect).not.toHaveBeenCalled();
      },
    );

    it('payload `exp` DÉJÀ DÉPASSÉE (≤ maintenant) → refus « unauthorized » ; aucun timer ; pas de disconnect', async () => {
      deps.jwtService.verifyAsync.mockResolvedValue(validPayload(PAST_EXP_S()));
      deps.usersService.findById.mockResolvedValue(validUser());
      const socket = makeSocket({ [SOCKET_AUTH_TOKEN_KEY]: VALID_TOKEN });
      const { next } = await run(socket);
      expect(next).toHaveBeenCalledTimes(1);
      expect((next.mock.calls[0][0] as Error).message).toBe('unauthorized');
      expect(socket.data.user).toBeUndefined();
      // Aucun timer programmé, pas de déconnexion forcée : le refus est
      // immédiat au handshake.
      expect(socket.once).not.toHaveBeenCalled();
      expect(socket.disconnect).not.toHaveBeenCalled();
    });
  });
});

/**
 * Déconnexion à l'expiration du JWT — `scheduleSocketDisconnectAtExpiry`.
 * Fake timers + `setSystemTime` (déterministe : délais exactement calculés) :
 * - `exp` futur → `socket.disconnect(true)` EXACTEMENT à l'échéance, jamais
 *   avant ; le listener `disconnect` est retiré au déclenchement ;
 * - `exp` déjà dépassé → `Math.max(delay, 0)` : déclenchement immédiate au
 *   prochain tick (aucun retard négatif) ;
 * - `exp` absent / non-number / NaN / Infinity → **aucun timer**, aucun log ;
 * - cleanup : `disconnect` client avant l'échéance → `clearTimeout` + aucun
 *   appel ultérieur (pas de fuite, pas de double appel) ;
 * - `unref()` : le timer ne maintient PAS le process ouvert.
 *
 * Aucun skip / todo / only.
 */
describe('scheduleSocketDisconnectAtExpiry — déconnexion à l’expiration du JWT', () => {
  // Horloge figée : délais calculés exactement (aucune dérive de seconde
  // réelle entre le calcul de `exp` et l'activation des fake timers).
  const FIXED_NOW_MS = Date.parse('2026-01-01T00:00:00.000Z');
  const BASE_S = Math.floor(FIXED_NOW_MS / 1000);
  const FUTURE_EXP_S = BASE_S + 60; // échéance à +60 000 ms exactement
  const PAST_EXP_S = BASE_S - 60;

  /** Socket minimal : `once` one-shot (sémantique EventEmitter), `off` par
   * référence, `disconnect` espionné. `installed` = listeners `once` actifs. */
  function makeFakeSocket() {
    const installed: Array<{
      event: string;
      raw: () => void;
      run: () => void;
    }> = [];
    const disconnect = jest.fn();
    const socket = {
      disconnect,
      once(event: string, rawFn: () => void) {
        const run = (): void => {
          const i = installed.findIndex((r) => r.run === run);
          if (i !== -1) installed.splice(i, 1); // one-shot
          rawFn();
        };
        installed.push({ event, raw: rawFn, run });
      },
      off(event: string, rawFn: () => void) {
        const before = installed.length;
        for (let i = installed.length - 1; i >= 0; i -= 1) {
          if (installed[i].event === event && installed[i].raw === rawFn) {
            installed.splice(i, 1);
          }
        }
        return installed.length < before;
      },
    };
    return { socket, disconnect, installed };
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(FIXED_NOW_MS);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('programme `disconnect(true)` EXACTEMENT à la seconde `exp`, jamais avant', () => {
    const { socket, disconnect, installed } = makeFakeSocket();
    const handle = scheduleSocketDisconnectAtExpiry(socket as never, {
      exp: FUTURE_EXP_S,
    }) as unknown as TimerHandle;
    expect(jest.getTimerCount()).toBe(1);
    expect(installed).toHaveLength(1);
    expect(installed[0].event).toBe('disconnect');

    jest.advanceTimersByTime(59_999);
    expect(disconnect).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1); // 60 000 ms → exp exacte
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith(true);
    expect(jest.getTimerCount()).toBe(0);
    expect(installed).toHaveLength(0); // listener retiré au déclenchement
    expect(handle).toBeDefined(); // timer retourné (inspection directe)
  });

  it('appelle `unref()` sur le timer (le process ne reste PAS ouvert)', () => {
    const { socket } = makeFakeSocket();
    const handle = scheduleSocketDisconnectAtExpiry(socket as never, {
      exp: FUTURE_EXP_S,
    }) as unknown as TimerHandle;
    // Shim sinonjs : après `unref()` le handle n'a plus de ref sur l'event loop.
    expect(handle.hasRef?.()).toBe(false);
    expect(handle.refed).toBe(false);
  });

  it.each([
    ['absent', {}],
    ['non-number (string)', { exp: 'soon' }],
    ['null', { exp: null }],
    ['NaN', { exp: Number.NaN }],
    ['Infinity', { exp: Number.POSITIVE_INFINITY }],
  ])(
    'exp %s → AUCUN timer programmé (pas de crash, pas de log, pas de listener)',
    (_label, payload) => {
      const { socket, disconnect, installed } = makeFakeSocket();
      const logger = { warn: jest.fn(), error: jest.fn() };
      const handle = scheduleSocketDisconnectAtExpiry(
        socket as never,
        payload,
        logger as never,
      );
      expect(handle).toBeUndefined();
      expect(jest.getTimerCount()).toBe(0);
      expect(installed).toHaveLength(0);
      // Même après un grand bond : rien ne se déclenche.
      jest.advanceTimersByTime(10 * 24 * 3_600_000);
      expect(disconnect).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it('exp déjà dépassée au handshake → déconnexion au prochain tick (délai 0, pas de retard négatif)', () => {
    const { socket, disconnect } = makeFakeSocket();
    scheduleSocketDisconnectAtExpiry(socket as never, { exp: PAST_EXP_S });
    expect(jest.getTimerCount()).toBe(1);
    expect(disconnect).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith(true);
  });

  it('disconnect client avant l’échéance → timer nettoyé ; aucun appel ultérieur (pas de fuite / double appel)', () => {
    const { socket, disconnect, installed } = makeFakeSocket();
    scheduleSocketDisconnectAtExpiry(socket as never, { exp: FUTURE_EXP_S });
    expect(jest.getTimerCount()).toBe(1);

    // Le socket se déconnecte côté client (ex. fermeture du navigateur) :
    // le wrapper `run` déclenche la sémantique `once` (auto-retrait).
    const entry = installed[0];
    entry.run();
    expect(jest.getTimerCount()).toBe(0); // timer cleared
    expect(installed).toHaveLength(0); // one-shot auto-retiré

    // L'échéance passe : aucun appel différé, ni second appel.
    jest.advanceTimersByTime(120_000);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('le délai est calculé depuis `exp` (payload vérifié) et ignore le reste du payload', () => {
    const { socket, disconnect } = makeFakeSocket();
    // exp à +10 s ; le principal (sub/email/role) est ignoré.
    scheduleSocketDisconnectAtExpiry(socket as never, {
      sub: 'x',
      email: 'y',
      role: 'z',
      exp: BASE_S + 10,
    });
    jest.advanceTimersByTime(9_999);
    expect(disconnect).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
