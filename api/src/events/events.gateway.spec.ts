import 'reflect-metadata';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { EventsGateway } from './events.gateway';
import { UsersService } from '../users/users.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { SocketRegistryService } from '../organizations/socket-registry.service';

/**
 * Tests unitaires du `EventsGateway` (phase 0B.3).
 *
 * Périmètre unitaire (le reste — transports réels, `connect_error`,
 * `allowRequest` sur l'upgrade websocket, réflexion `cors.origin` en
 * long-polling — est couvert en E2E) :
 *
 * 1. **Options du décorateur** — `@WebSocketGateway` porte bien :
 *    - `cors.origin` : une **délegate function** (pas un tableau, pas `*`),
 *      pour qu'engine.io (`cors`) contrôle l'origine du long-polling ;
 *    - `allowRequest` : une **function** (pas un array), pour que
 *      `Server#verify` contrôle l'origine aussi sur l'upgrade websocket.
 *    C'est `@nestjs/platform-socket.io` (`IoAdapter`) qui transmet ces
 *    options au `Socket.IO Server` : ici on vérifie que la classe les
 *    porte bien — c'est la source de vérité que l'E2E consomme.
 *
 * 2. **Middleware installé UNE fois** — `afterInit` installe exactement un
 *    `io.use` par appel sur le serveur fourni (installation idempotente au
 *    niveau du provider : un seul `afterInit` par serveur).
 *
 * 3. **Garde production** — en `NODE_ENV=production`, `afterInit` lève si
 *    `CORS_ORIGIN` est absente (pas de valeur par défaut ouverte) ; en
 *    dev/test, pas de garde au niveau du provider (le fallback est géré au
 *    niveau du helper `parseCORSOrigin` — testé dans origin.helpers.spec).
 *
 * Le module de test ne monte pas `UsersModule` (sa `MongooseModule.
 * forFeature` exige la connexion Mongoose racine, qui n'existe pas en
 * unitaire) : on fournit `UsersService` et `JwtService` directement —
 * c'est exactement ce que `EventsModule` résout dans l'app réelle.
 *
 * Aucun skip / todo / only.
 */

const TEST_JWT_SECRET = 'unit-gateway-secret-not-production';

/** Clés de métadonnées du décorateur `@WebSocketGateway` (valeur réelle —
 *  vérifiée dans @nestjs/websockets/constants : 'websockets:gateway_options'
 *  et 'websockets:is_gateway'). */
const GATEWAY_OPTIONS_KEY = 'websockets:gateway_options';
const GATEWAY_METADATA_KEY = 'websockets:is_gateway';

describe('EventsGateway (unité)', () => {
  let gateway: EventsGateway;
  let socketRegistry: { register: jest.Mock; unregister: jest.Mock };

  async function compileGateway() {
    socketRegistry = { register: jest.fn(), unregister: jest.fn() };
    const module = await Test.createTestingModule({
      providers: [
        EventsGateway,
        {
          provide: JwtService,
          useValue: new JwtService({ secret: TEST_JWT_SECRET }),
        },
        {
          provide: UsersService,
          useValue: { findById: jest.fn() },
        },
        {
          provide: OrganizationsService,
          useValue: { resolveActiveContext: jest.fn() },
        },
        { provide: SocketRegistryService, useValue: socketRegistry },
      ],
    }).compile();
    gateway = module.get(EventsGateway);
    return module;
  }

  it('porte le marqueur de gateway NestJS (`GATEWAY_METADATA`) sur la classe', () => {
    expect(Reflect.getMetadata(GATEWAY_METADATA_KEY, EventsGateway)).toBe(true);
  });

  describe('options du décorateur (source de vérité pour l’IoAdapter)', () => {
    let options: Record<string, unknown> | undefined;

    beforeAll(() => {
      options = Reflect.getMetadata(GATEWAY_OPTIONS_KEY, EventsGateway);
    });

    it('déclare `cors.origin` comme fonction déléguée (pas un tableau, jamais `*`)', () => {
      expect(options).toBeDefined();
      const cors = (options as { cors?: Record<string, unknown> }).cors;
      expect(cors).toBeDefined();
      expect(typeof cors.origin).toBe('function');
      expect(cors.origin).not.toBe('*');
    });

    it('déclare `allowRequest` comme fonction (contrôle origine sur le handshake + upgrade websocket)', () => {
      expect(options).toBeDefined();
      expect(typeof options.allowRequest).toBe('function');
    });

    it('les deux options relisent `process.env.CORS_ORIGIN` à la volée et non au boot', () => {
      // `allowRequest` doit lire l'env **au moment de la requête** : pour
      // un serveur créé AVANT que l'env soit réglée (cas du test E2E), la
      // valeur doit être effective. On teste sur la fonction elle-même :
      // elle ne lit PAS une variable figée au module-load.
      const previous = process.env.CORS_ORIGIN;
      try {
        process.env.CORS_ORIGIN = 'http://localhost:3000';
        const req = { headers: { origin: 'http://localhost:3000' } };
        let result: { success: boolean };
        (
          options as {
            allowRequest: (
              req: { headers: Record<string, unknown> },
              fn: (err: string | null, success: boolean) => void,
            ) => void;
          }
        ).allowRequest(req, (err, success) => {
          expect(err).toBeNull();
          result = { success };
        });
        expect(result.success).toBe(true);
      } finally {
        process.env.CORS_ORIGIN = previous;
      }
    });
  });

  describe('afterInit', () => {
    beforeEach(async () => {
      await compileGateway();
    });

    it('installe le middleware d’authentification EXACTEMENT UNE fois sur le serveur fourni', () => {
      const use = jest.fn();
      const serverStub = { use } as never;
      gateway.afterInit(serverStub);
      expect(use).toHaveBeenCalledTimes(1);
      expect(typeof use.mock.calls[0][0]).toBe('function');
      // Un 2e `afterInit` sur un serveur FRAIS reste une installation
      // unique par appel (l'app ne fait qu'un seul `afterInit` par serveur).
      const use2 = jest.fn();
      gateway.afterInit({ use: use2 } as never);
      expect(use2).toHaveBeenCalledTimes(1);
    });

    it('en dev (non-production), `afterInit` ne lève pas même si CORS_ORIGIN est absente', () => {
      const previous = process.env.CORS_ORIGIN;
      const previousNodeEnv = process.env.NODE_ENV;
      try {
        delete process.env.CORS_ORIGIN;
        process.env.NODE_ENV = 'development';
        expect(() =>
          gateway.afterInit({ use: jest.fn() } as never),
        ).not.toThrow();
      } finally {
        process.env.CORS_ORIGIN = previous;
        process.env.NODE_ENV = previousNodeEnv;
      }
    });

    it('en production, `afterInit` lève si CORS_ORIGIN est absente (garde : démarrage refusé)', () => {
      const previous = process.env.CORS_ORIGIN;
      const previousNodeEnv = process.env.NODE_ENV;
      try {
        delete process.env.CORS_ORIGIN;
        process.env.NODE_ENV = 'production';
        expect(() => gateway.afterInit({ use: jest.fn() } as never)).toThrow(
          /CORS_ORIGIN is required in production/,
        );
      } finally {
        process.env.CORS_ORIGIN = previous;
        process.env.NODE_ENV = previousNodeEnv;
      }
    });

    it('en production, `afterInit` lève si CORS_ORIGIN est invalide (wildcard `*`)', () => {
      const previous = process.env.CORS_ORIGIN;
      const previousNodeEnv = process.env.NODE_ENV;
      try {
        process.env.CORS_ORIGIN = '*';
        process.env.NODE_ENV = 'production';
        expect(() => gateway.afterInit({ use: jest.fn() } as never)).toThrow(
          /CORS_ORIGIN/,
        );
      } finally {
        process.env.CORS_ORIGIN = previous;
        process.env.NODE_ENV = previousNodeEnv;
      }
    });
  });

  describe('rooms organisationnelles', () => {
    beforeEach(async () => {
      await compileGateway();
    });

    it('joint exactement la room issue du contexte résolu', () => {
      const client = {
        data: {
          organizationContext: {
            organizationId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
            userId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
          },
        },
        join: jest.fn(),
        disconnect: jest.fn(),
      };

      gateway.handleConnection(client as never);

      expect(client.join).toHaveBeenCalledWith(
        'organization:aaaaaaaaaaaaaaaaaaaaaaaa',
      );
      expect(client.disconnect).not.toHaveBeenCalled();
    });

    it('déconnecte défensivement un socket sans contexte et ne joint aucune room', () => {
      const client = {
        data: {},
        join: jest.fn(),
        disconnect: jest.fn(),
      };

      gateway.handleConnection(client as never);

      expect(client.join).not.toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it('déconnecte défensivement un socket avec organizationId mais SANS userId (contexte incomplet)', () => {
      const client = {
        data: {
          organizationContext: { organizationId: 'aaaaaaaaaaaaaaaaaaaaaaaa' },
        },
        join: jest.fn(),
        disconnect: jest.fn(),
      };

      gateway.handleConnection(client as never);

      expect(client.join).not.toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(socketRegistry.register).not.toHaveBeenCalled();
    });

    it('1-7C : enregistre la socket dans le registre (org+user) à la connexion', () => {
      const client = {
        data: {
          organizationContext: {
            organizationId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
            userId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
          },
        },
        join: jest.fn(),
        disconnect: jest.fn(),
      };

      gateway.handleConnection(client as never);

      expect(socketRegistry.register).toHaveBeenCalledWith(
        'aaaaaaaaaaaaaaaaaaaaaaaa',
        'bbbbbbbbbbbbbbbbbbbbbbbb',
        client,
      );
    });

    it('1-7C : désenregistre la socket du registre à la déconnexion', () => {
      const client = {
        data: {
          organizationContext: {
            organizationId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
            userId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
          },
        },
      };

      gateway.handleDisconnect(client as never);

      expect(socketRegistry.unregister).toHaveBeenCalledWith(
        'aaaaaaaaaaaaaaaaaaaaaaaa',
        'bbbbbbbbbbbbbbbbbbbbbbbb',
        client,
      );
    });

    it('1-7C : handleDisconnect sans contexte est un no-op (aucune erreur, aucun appel)', () => {
      const client = { data: {} };
      expect(() => gateway.handleDisconnect(client as never)).not.toThrow();
      expect(socketRegistry.unregister).not.toHaveBeenCalled();
    });

    it('émet uniquement via server.to(room).emit', () => {
      const emit = jest.fn();
      const to = jest.fn(() => ({ emit }));
      gateway.server = { to } as never;

      gateway.emitToOrganization('aaaaaaaaaaaaaaaaaaaaaaaa', 'sale:created', {
        id: 'sale-a',
      });

      expect(to).toHaveBeenCalledWith('organization:aaaaaaaaaaaaaaaaaaaaaaaa');
      expect(emit).toHaveBeenCalledWith('sale:created', { id: 'sale-a' });
    });
  });
});
