import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { resetAuthRateLimits } from './e2e/rate-limit-fixtures';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { LOGIN_SHORT_LIMIT } from './../src/common/auth-rate-limiting';
import {
  ExpressSettings,
  applyTrustProxy,
  resolveTrustProxySetting,
} from './../src/common/trust-proxy';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import { createE2eEmailSender } from './e2e/email-verification-fixtures';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';

/**
 * E2E 1-14D.2E — Confiance proxy appliquée par le MÊME code que `main.ts`
 * (`resolveTrustProxySetting` + `applyTrustProxy`), sur la vraie route
 * `POST /auth/login` et son `AuthThrottlerGuard` (tracker `req.ip`).
 *
 * Toutes les requêtes supertest partent de 127.0.0.1 : ce fichier vérifie
 * la PLOMBERIE de la confiance (en-têtes forgés ignorés sans confiance,
 * proxy approuvé par adresse exacte). La preuve avec des adresses sources
 * RÉELLEMENT distinctes à travers le vrai nginx est faite par le harnais
 * `api/test/proxy/` (Docker).
 *
 * `req.ip` est observé par un middleware de FIXTURE enregistré uniquement
 * ici : aucune route de diagnostic n'existe en production.
 */

const LOGIN_BODY = { email: 'nobody-14d2e@proxy.test', password: 'wrong-pw-1' };

describe('Confiance proxy et limitation de débit par IP (e2e 1-14D.2E)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  const observed: string[] = [];

  const express = () =>
    app.getHttpAdapter().getInstance() as ExpressSettings & {
      get(name: string): unknown;
    };
  // 1-18C : compteurs IP en mémoire ET plafonds persistants par compte.
  const clearThrottle = () => resetAuthRateLimits(moduleFixture);

  /** Réglage comme `main.ts` ; le défaut Express est restauré entre les cas. */
  async function configure(env: NodeJS.ProcessEnv) {
    express().set('trust proxy', false);
    applyTrustProxy(express(), resolveTrustProxySetting(env));
    await clearThrottle();
    observed.length = 0;
  }

  const login = (
    headers: Record<string, string> = {},
    body: typeof LOGIN_BODY = LOGIN_BODY,
  ) => {
    const req = request(app.getHttpServer()).post('/auth/login');
    for (const [name, value] of Object.entries(headers)) req.set(name, value);
    return req.send(body);
  };

  /** Statuts de N tentatives successives avec des en-têtes donnés. */
  async function attempts(
    count: number,
    headers: (i: number) => Record<string, string>,
  ): Promise<number[]> {
    const statuses: number[] = [];
    for (let i = 0; i < count; i++) {
      statuses.push((await login(headers(i))).status);
    }
    return statuses;
  }

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = 'trust-proxy-14d2e-e2e-only-secret';
      process.env.CORS_ORIGIN = 'https://trust-proxy-e2e.example.com';
      moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EMAIL_SENDER)
        .useValue(createE2eEmailSender())
        .compile();
      app = moduleFixture.createNestApplication();
      // FIXTURE de test : observe `req.ip` tel que résolu par Express.
      app.use((req: Request, res: Response, next: NextFunction) => {
        res.on('finish', () => observed.push(req.ip ?? ''));
        next();
      });
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      app.useGlobalFilters(new HttpExceptionFilter());
      await app.init();
    } catch (error) {
      await stopEphemeralMongoSafe();
      throw error;
    }
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  describe('sans confiance proxy (défaut)', () => {
    beforeEach(() => configure({}));

    it('`trust proxy` non réglé ; en-têtes forgés ignorés : `req.ip` = adresse de la connexion', async () => {
      expect(express().get('trust proxy')).toBe(false);
      await login({
        'X-Forwarded-For': '203.0.113.9',
        'X-Real-IP': '203.0.113.9',
        Forwarded: 'for=203.0.113.9',
      });
      await login({ 'X-Forwarded-For': '198.51.100.1, 198.51.100.2' });
      expect(observed).toHaveLength(2);
      for (const ip of observed) {
        expect(ip).toMatch(/^(::ffff:)?127\.0\.0\.1$|^::1$/);
      }
    });

    it('XFF forgé, seul, en liste ou changé à chaque requête : la limite n’est JAMAIS réinitialisée', async () => {
      const statuses = await attempts(LOGIN_SHORT_LIMIT + 3, (i) =>
        i % 2 === 0
          ? { 'X-Forwarded-For': `203.0.113.${i + 1}` }
          : { 'X-Forwarded-For': `198.51.100.${i}, 203.0.113.${i}` },
      );
      expect(statuses.slice(0, LOGIN_SHORT_LIMIT).every((s) => s === 401)).toBe(
        true,
      );
      expect(statuses.slice(LOGIN_SHORT_LIMIT)).toEqual([429, 429, 429]);
      // Contrat 0B.6 conservé : corps stable + Retry-After.
      const blocked = await login({ 'X-Forwarded-For': '192.0.2.77' });
      expect(blocked.status).toBe(429);
      expect(blocked.body.code).toBe('AUTH_RATE_LIMITED');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    });
  });

  describe('proxy approuvé par ADRESSE EXACTE', () => {
    it('connexion depuis le proxy approuvé : `req.ip` = adresse transmise par le proxy', async () => {
      await configure({ TRUST_PROXY_ADDRESSES: '127.0.0.1' });
      await login({ 'X-Forwarded-For': '203.0.113.10' });
      expect(observed).toEqual(['203.0.113.10']);
    });

    it('compteurs par adresse transmise : A limité (429), B toujours autorisé (401)', async () => {
      await configure({ TRUST_PROXY_ADDRESSES: '127.0.0.1' });
      const a = await attempts(LOGIN_SHORT_LIMIT + 1, () => ({
        'X-Forwarded-For': '203.0.113.10',
      }));
      expect(a[LOGIN_SHORT_LIMIT]).toBe(429);
      // 1-18C : autre identifiant (le compte de A est désormais plafonné
      // pour toutes les IP) ; seul le compteur PAR IP est observé ici.
      expect(
        (
          await login(
            { 'X-Forwarded-For': '203.0.113.20' },
            { ...LOGIN_BODY, email: 'other-account-14d2e@royalvibe.test' },
          )
        ).status,
      ).toBe(401);
    });

    it('source NON approuvée (adresse d’un autre proxy) : en-têtes ignorés, aucune usurpation', async () => {
      await configure({ TRUST_PROXY_ADDRESSES: '172.31.250.2' });
      const statuses = await attempts(LOGIN_SHORT_LIMIT + 1, (i) => ({
        'X-Forwarded-For': `203.0.113.${i + 1}`,
      }));
      expect(statuses[LOGIN_SHORT_LIMIT]).toBe(429);
      for (const ip of observed) {
        expect(ip).toMatch(/^(::ffff:)?127\.0\.0\.1$|^::1$/);
      }
    });
  });

  describe('paramètres invalides refusés (démarrage bloqué)', () => {
    it.each([
      [{ TRUST_PROXY_ADDRESSES: '172.31.250.0/29' }],
      [{ TRUST_PROXY_ADDRESSES: 'loopback' }],
      [{ TRUST_PROXY_ADDRESSES: '172.31.250.2abc' }],
      [{ TRUST_PROXY_HOPS: '-1' }],
      [{ TRUST_PROXY_HOPS: '1.5' }],
      [{ TRUST_PROXY_HOPS: 'true' }],
      [{ TRUST_PROXY_HOPS: '1', TRUST_PROXY_ADDRESSES: '172.31.250.2' }],
    ])('%p', (env) => {
      expect(() => resolveTrustProxySetting(env)).toThrow();
    });
  });
});
