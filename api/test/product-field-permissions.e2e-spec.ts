import 'reflect-metadata';
import type { AddressInfo } from 'net';
import { Model, Types } from 'mongoose';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { UserDocument } from './../src/users/schemas/user.schema';
import { OrganizationMembership } from './../src/organizations/schemas/membership.schema';
import type { OrganizationMembershipDocument } from './../src/organizations/schemas/membership.schema';
import { Product } from './../src/products/schemas/product.schema';
import type { ProductDocument } from './../src/products/schemas/product.schema';
import { Sale } from './../src/sales/schemas/sale.schema';
import type { SaleDocument } from './../src/sales/schemas/sale.schema';
import {
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import {
  buildOriginAllowlist,
  parseCORSOrigin,
  buildHttpCorsOptions,
} from './../src/events/origin.helpers';
import { EMAIL_SENDER } from '../src/email-verification/email-sender';
import {
  E2E_EMAIL_VERIFIED_AT,
  autoConfirmVerificationEmails,
  createE2eEmailSender,
} from './e2e/email-verification-fixtures';
import { createInvitedAccount } from './e2e/invitation-acceptance-fixtures';
import { OWNER_TERMS } from './e2e/legal-acceptance-fixtures';

// 1-13A : expéditeur simulé, liens confirmés via le service réel.
const emailSender = createE2eEmailSender();

/**
 * E2E (1-12H) — droits standard des membres, visibilité des informations
 * produit (standard / détail du stock / finances) et agrégats produit
 * INDÉPENDANTS des ventes consultables par le demandeur. `MongoMemoryReplSet`
 * réel + serveur Socket.IO attaché pour inspecter les diffusions.
 */

const TEST_JWT_SECRET = 'product-fields-e2e-only-secret';
const E2E_CORS_ORIGIN = 'https://product-fields-e2e.example.com';
const PASSWORD = 'product-fields-12h-pw-!1x';

const FINANCIAL_KEYS = [
  'actualRevenue',
  'actualProfit',
  'margin',
  'totalPurchaseCost',
];

interface Member {
  userId: string;
  membershipId: string;
  token: string;
}

describe('Permissions et visibilité des informations produit (e2e 1-12H)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;
  let port = 0;
  let userModel: Model<UserDocument>;
  let membershipModel: Model<OrganizationMembershipDocument>;
  let productModel: Model<ProductDocument>;
  let saleModel: Model<SaleDocument>;

  let orgAId = '';
  let orgBId = '';
  let ownerA = '';
  let ownerB = '';
  let sectionA = '';
  let productId = '';
  let sellerA: Member; // vendeur A, sans délégation
  let sellerB: Member; // vendeur B, finances seules
  let stockSeller: Member; // détail du stock seul
  let bothSeller: Member; // deux groupes
  let inviterSeller: Member; // members.invite seul
  let trashSeller: Member; // trash.manage seul
  let saleA = '';
  let saleB = '';

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = (email: string, organizationId?: string) =>
    http()
      .post('/auth/login')
      .send({ email, password: PASSWORD, organizationId });
  const getProduct = (token: string) =>
    http().get(`/products/${productId}`).set(auth(token));
  const listProducts = (token: string) =>
    http().get('/products').query({ sectionId: sectionA }).set(auth(token));
  const sell = (token: string, quantity: number, salePrice: number) =>
    http()
      .post('/sales')
      .set(auth(token))
      .send({ productId, quantity, salePrice, buyerName: 'Acheteur' });

  async function createMember(
    name: string,
    email: string,
    permissions: string[] = [],
  ): Promise<Member> {
    const userId = new Types.ObjectId();
    const membershipId = new Types.ObjectId();
    await userModel.create({
      emailVerifiedAt: E2E_EMAIL_VERIFIED_AT,
      _id: userId,
      name,
      email,
      password: await bcrypt.hash(PASSWORD, 10),
    });
    await membershipModel.create({
      _id: membershipId,
      organizationId: new Types.ObjectId(orgAId),
      userId,
      role: 'seller',
      status: 'active',
      permissions,
    });
    const res = await login(email, orgAId);
    expect(res.status).toBe(201);
    return {
      userId: userId.toHexString(),
      membershipId: membershipId.toHexString(),
      token: res.body.access_token as string,
    };
  }

  function connectSocket(token: string): Promise<Socket> {
    const socket = io(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 4_000,
      extraHeaders: { origin: E2E_CORS_ORIGIN },
      auth: { token },
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('connect timeout')),
        5_000,
      );
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
    });
  }

  function nextEvent(socket: Socket, event: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${event} not received`)),
        5_000,
      );
      socket.once(event, (payload: unknown) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      process.env.MONGODB_URI = validatedEphemeralUri(replSet);
      process.env.JWT_SECRET = TEST_JWT_SECRET;
      process.env.S3_ENDPOINT = 'http://127.0.0.1:65535';
      process.env.S3_REGION = 'us-east-1';
      process.env.S3_ACCESS_KEY = 'e2e-local';
      process.env.S3_SECRET_KEY = 'e2e-local';
      process.env.S3_BUCKET = 'e2e-local';
      process.env.S3_FORCE_PATH_STYLE = 'true';
      process.env.CORS_ORIGIN = E2E_CORS_ORIGIN;
      process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
      process.env.PUBLIC_APP_URL = 'https://app.product-fields-e2e.test';

      moduleFixture = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(EMAIL_SENDER)
        .useValue(emailSender)
        .compile();
      app = moduleFixture.createNestApplication();
      app.enableCors(
        buildHttpCorsOptions(
          buildOriginAllowlist(parseCORSOrigin(E2E_CORS_ORIGIN, 'development')),
        ),
      );
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      app.useGlobalFilters(new HttpExceptionFilter());
      await app.init();
      autoConfirmVerificationEmails(app, emailSender);
      await app.listen(0);
      port = (app.getHttpServer().address() as AddressInfo).port;

      userModel = moduleFixture.get(getModelToken('User'));
      membershipModel = moduleFixture.get(
        getModelToken(OrganizationMembership.name),
      );
      productModel = moduleFixture.get(getModelToken(Product.name));
      saleModel = moduleFixture.get(getModelToken(Sale.name));

      for (const [key, org] of [
        ['a', 'Org A 12H'],
        ['b', 'Org B 12H'],
      ] as const) {
        const reg = await http()
          .post('/auth/register')
          .send({
            ...OWNER_TERMS,
            name: `Owner ${key}`,
            email: `owner-${key}-12h@royalvibe.test`,
            password: PASSWORD,
            organizationName: org,
          });
        expect(reg.status).toBe(201);
        const orgId = reg.body.organization._id as string;
        const res = await login(`owner-${key}-12h@royalvibe.test`, orgId);
        if (key === 'a') {
          orgAId = orgId;
          ownerA = res.body.access_token as string;
        } else {
          orgBId = orgId;
          ownerB = res.body.access_token as string;
        }
      }

      const section = await http()
        .post('/sections')
        .set(auth(ownerA))
        .send({ name: 'Section 12H' });
      expect(section.status).toBe(201);
      sectionA = section.body._id as string;

      // Produit A : achat 1 000, cible 1 800, 10 unités (sans S3).
      const product = await productModel.create({
        organizationId: new Types.ObjectId(orgAId),
        sectionId: new Types.ObjectId(sectionA),
        name: 'Parfum 12H',
        imageUrl: 'https://e2e.local/img.png',
        purchasePrice: 1000,
        salePrice: 1800,
        initialQuantity: 10,
        remainingQuantity: 10,
      });
      productId = product._id.toString();

      sellerA = await createMember('Vendeur A', 'seller-a-12h@royalvibe.test');
      sellerB = await createMember('Vendeur B', 'seller-b-12h@royalvibe.test', [
        'products.view_financials',
      ]);
      stockSeller = await createMember(
        'Vendeur Stock',
        'seller-stock-12h@royalvibe.test',
        ['products.view_stock_details'],
      );
      bothSeller = await createMember(
        'Vendeur Deux',
        'seller-both-12h@royalvibe.test',
        ['products.view_stock_details', 'products.view_financials'],
      );
      inviterSeller = await createMember(
        'Vendeur Invite',
        'seller-invite-12h@royalvibe.test',
        ['members.invite'],
      );
      trashSeller = await createMember(
        'Vendeur Corbeille',
        'seller-trash-12h@royalvibe.test',
        ['trash.manage'],
      );
    } catch (err) {
      if (moduleFixture) await moduleFixture.close().catch(() => undefined);
      await stopEphemeralMongoSafe();
      throw err;
    }
  }, 180_000);

  // Rate limiting existant (login/acceptation par IP, stockage mémoire) :
  // remis à zéro avant chaque test — cette suite enchaîne de nombreuses
  // connexions depuis la même IP (même convention que invitations.e2e).
  beforeEach(() => {
    moduleFixture.get(ThrottlerStorage).onApplicationShutdown();
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  describe('1. Droits standard', () => {
    it('vendeur sans aucune permission stockée : peut enregistrer une vente et voir ses propres ventes', async () => {
      const membership = await membershipModel
        .findById(sellerA.membershipId)
        .exec();
      expect(membership!.permissions).toEqual([]);
      const context = await http()
        .get('/auth/context')
        .set(auth(sellerA.token));
      expect(context.body.effectivePermissions).toEqual(
        expect.arrayContaining(['sales.record', 'sales.view_own']),
      );
      expect(context.body.effectivePermissions).not.toContain('sales.view_all');

      const sale = await sell(sellerA.token, 2, 1500);
      expect(sale.status).toBe(201);
      saleA = sale.body._id as string;
    });

    it('membership suspendue : les droits standard ne contournent jamais la suspension', async () => {
      const suspended = await createMember(
        'Vendeur Suspendu',
        'seller-suspended-12h@royalvibe.test',
      );
      await membershipModel.updateOne(
        { _id: new Types.ObjectId(suspended.membershipId) },
        { $set: { status: 'suspended' } },
      );
      const before = await saleModel.countDocuments();
      const res = await sell(suspended.token, 1, 1500);
      expect([401, 403]).toContain(res.status);
      expect(await saleModel.countDocuments()).toBe(before);
      const list = await http().get('/sales').set(auth(suspended.token));
      expect([401, 403]).toContain(list.status);
    });

    it('une édition de membre avec permissions [] ne retire pas les droits standard', async () => {
      const res = await http()
        .patch(`/organizations/members/${stockSeller.membershipId}`)
        .set(auth(ownerA))
        .send({ permissions: ['products.view_stock_details'] });
      expect(res.status).toBe(200);
      const relog = await login('seller-stock-12h@royalvibe.test', orgAId);
      const context = await http()
        .get('/auth/context')
        .set(auth(relog.body.access_token as string));
      expect(context.body.effectivePermissions).toEqual(
        expect.arrayContaining(['sales.record', 'sales.view_own']),
      );
    });
  });

  describe('2. Agrégats indépendants des ventes consultables (complément 1-12H)', () => {
    it('vendeur B (finances seules) vend 3 × 2 000 ; une vente d’une AUTRE organisation sur le même productId est ignorée', async () => {
      const sale = await sell(sellerB.token, 3, 2000);
      expect(sale.status).toBe(201);
      saleB = sale.body._id as string;
      // Document forgé : vente de l'organisation B portant le productId A.
      await saleModel.create({
        organizationId: new Types.ObjectId(orgBId),
        productId: new Types.ObjectId(productId),
        quantity: 7,
        salePrice: 99999,
        sellerId: new Types.ObjectId(),
      });
    });

    it('propriétaire et vendeur B voient les MÊMES agrégats : CA réel 9 000 (prix appliqués, jamais le prix cible)', async () => {
      const owner = await getProduct(ownerA);
      const seller = await getProduct(sellerB.token);
      expect(owner.status).toBe(200);
      expect(seller.status).toBe(200);
      for (const res of [owner, seller]) {
        expect(res.body.actualRevenue).toBe(9000);
        expect(res.body.actualProfit).toBe(9000 - 1000 * 5);
        expect(res.body.margin).toBeCloseTo((4000 / 9000) * 100);
        expect(res.body.totalPurchaseCost).toBe(10000);
        expect(res.body.product.purchasePrice).toBe(1000);
      }
      // Même source pour la liste (cartes) et la fiche.
      const list = await listProducts(sellerB.token);
      const row = (list.body as Array<Record<string, unknown>>)[0];
      expect(row.actualRevenue).toBe(9000);
      expect(row.margin).toBeCloseTo((4000 / 9000) * 100);
    });

    it('vendeur B consulte toujours UNIQUEMENT ses propres ventes (fiche et /sales), sans données du vendeur A', async () => {
      const detail = await getProduct(sellerB.token);
      const sales = detail.body.sales as Array<{ _id: string }>;
      expect(sales.map((s) => s._id)).toEqual([saleB]);
      const list = await http().get('/sales').set(auth(sellerB.token));
      expect((list.body as Array<{ _id: string }>).map((s) => s._id)).toEqual([
        saleB,
      ]);
      expect(JSON.stringify(detail.body)).not.toContain('Vendeur A');
      expect(JSON.stringify(detail.body)).not.toContain(saleA);
    });

    it('vendeur A (standard) : prix cible et stock restant seulement ; agrégats, prix d’achat, stock initial ABSENTS', async () => {
      for (const res of [
        await getProduct(sellerA.token),
        await listProducts(sellerA.token),
      ]) {
        expect(res.status).toBe(200);
        const view = Array.isArray(res.body)
          ? (res.body as Array<Record<string, unknown>>)[0]
          : (res.body as Record<string, unknown>);
        const product = view.product as Record<string, unknown>;
        expect(product.salePrice).toBe(1800);
        expect(product.remainingQuantity).toBe(5);
        for (const key of [...FINANCIAL_KEYS, 'unitsSold']) {
          expect(view).not.toHaveProperty(key);
        }
        expect(product).not.toHaveProperty('purchasePrice');
        expect(product).not.toHaveProperty('initialQuantity');
        expect(product).not.toHaveProperty('organizationId');
      }
    });

    it('détail du stock seul : stock initial et unités vendues (5, indépendant du vendeur), aucune donnée financière', async () => {
      const relog = await login('seller-stock-12h@royalvibe.test', orgAId);
      const res = await getProduct(relog.body.access_token as string);
      expect(res.body.unitsSold).toBe(5);
      expect(res.body.product.initialQuantity).toBe(10);
      for (const key of FINANCIAL_KEYS)
        expect(res.body).not.toHaveProperty(key);
      expect(res.body.product).not.toHaveProperty('purchasePrice');
    });

    it('deux groupes : toutes les informations', async () => {
      const res = await getProduct(bothSeller.token);
      expect(res.body.unitsSold).toBe(5);
      expect(res.body.product.initialQuantity).toBe(10);
      expect(res.body.actualRevenue).toBe(9000);
    });

    it('modification puis suppression d’une vente : les totaux suivent (8 000 puis 2 000)', async () => {
      const patched = await http()
        .patch(`/sales/${saleA}`)
        .set(auth(sellerA.token))
        .send({ salePrice: 1000 });
      expect(patched.status).toBe(200);
      let res = await getProduct(ownerA);
      expect(res.body.actualRevenue).toBe(2 * 1000 + 3 * 2000);

      const removed = await http().delete(`/sales/${saleB}`).set(auth(ownerA));
      expect(removed.status).toBe(204);
      res = await getProduct(sellerB.token);
      expect(res.body.actualRevenue).toBe(2000);
      expect(res.body.product.purchasePrice).toBe(1000);
      const stock = await getProduct(bothSeller.token);
      expect(stock.body.unitsSold).toBe(2);
      expect(res.body.actualProfit).toBe(2000 - 1000 * 2);
    });

    it('organisation B : le produit A reste invisible (404)', async () => {
      const res = await http().get(`/products/${productId}`).set(auth(ownerB));
      expect(res.status).toBe(404);
    });
  });

  describe('3. Autres réponses et diffusions', () => {
    it('corbeille (trash.manage sans finances) : prix d’achat et stock initial absents', async () => {
      const trashed = await productModel.create({
        organizationId: new Types.ObjectId(orgAId),
        sectionId: new Types.ObjectId(sectionA),
        name: 'Corbeille 12H',
        imageUrl: 'https://e2e.local/img.png',
        purchasePrice: 700,
        salePrice: 900,
        initialQuantity: 4,
        remainingQuantity: 4,
        deletedAt: new Date(),
      });
      const res = await http().get('/trash').set(auth(trashSeller.token));
      expect(res.status).toBe(200);
      const row = (res.body.products as Array<Record<string, unknown>>).find(
        (p) => p._id === trashed._id.toString(),
      );
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty('purchasePrice');
      expect(row).not.toHaveProperty('initialQuantity');
      expect(row!.salePrice).toBe(900);
    });

    it('Socket.IO : product:updated et sale:created reçus par un vendeur standard sans aucun champ restreint', async () => {
      const socket = await connectSocket(sellerA.token);
      try {
        const updated = nextEvent(socket, 'product:updated');
        const patch = await http()
          .patch(`/products/${productId}`)
          .set(auth(ownerA))
          .send({ salePrice: 1900 });
        expect(patch.status).toBe(200);
        // La réponse HTTP du demandeur autorisé reste complète.
        expect(patch.body.product.purchasePrice).toBe(1000);
        expect(patch.body.actualRevenue).toBe(2000);
        const payload = (await updated) as Record<string, unknown>;
        expect(Object.keys(payload).sort()).toEqual(['product', 'status']);
        const product = payload.product as Record<string, unknown>;
        expect(product.salePrice).toBe(1900);
        for (const key of [
          'purchasePrice',
          'initialQuantity',
          'organizationId',
        ]) {
          expect(product).not.toHaveProperty(key);
        }

        const saleEvent = nextEvent(socket, 'sale:created');
        const sale = await sell(ownerA, 1, 1900);
        expect(sale.status).toBe(201);
        const salePayload = (await saleEvent) as Record<string, unknown>;
        expect(salePayload).toEqual({
          _id: sale.body._id as string,
          productId,
        });
      } finally {
        socket.disconnect();
      }
    });
  });

  describe('3 bis. Invalidation après modification et suppression de vente (correctif 1-12H)', () => {
    it('sale:updated puis sale:deleted : identifiants seuls, reçus par un collègue ; totaux rechargés via l’API conformes', async () => {
      const socket = await connectSocket(sellerB.token);
      try {
        const created = await sell(sellerA.token, 2, 1500);
        expect(created.status).toBe(201);
        const saleId = created.body._id as string;
        const before = (await getProduct(sellerB.token)).body
          .actualRevenue as number;

        const updatedEvent = nextEvent(socket, 'sale:updated');
        const patched = await http()
          .patch(`/sales/${saleId}`)
          .set(auth(sellerA.token))
          .send({ salePrice: 1000 });
        expect(patched.status).toBe(200);
        expect(await updatedEvent).toEqual({ _id: saleId, productId });
        let res = await getProduct(sellerB.token);
        expect(res.body.actualRevenue).toBe(before - 2 * 500);
        // B conserve uniquement ses propres ventes dans l'historique.
        expect(
          (res.body.sales as Array<{ _id: string }>).some(
            (s) => s._id === saleId,
          ),
        ).toBe(false);

        const deletedEvent = nextEvent(socket, 'sale:deleted');
        const removed = await http()
          .delete(`/sales/${saleId}`)
          .set(auth(sellerA.token));
        expect(removed.status).toBe(204);
        expect(await deletedEvent).toEqual({ _id: saleId, productId });
        res = await getProduct(sellerB.token);
        expect(res.body.actualRevenue).toBe(before - 2 * 1500);
      } finally {
        socket.disconnect();
      }
    });

    it('échec de modification (vente d’un autre vendeur, 404) : aucun événement', async () => {
      const socket = await connectSocket(ownerA);
      try {
        const own = await sell(ownerA, 1, 1900);
        const received: string[] = [];
        socket.on('sale:updated', () => received.push('updated'));
        socket.on('sale:deleted', () => received.push('deleted'));
        const res = await http()
          .patch(`/sales/${own.body._id as string}`)
          .set(auth(sellerA.token))
          .send({ salePrice: 1 });
        expect(res.status).toBe(404);
        const del = await http()
          .delete(`/sales/${own.body._id as string}`)
          .set(auth(sellerA.token));
        expect(del.status).toBe(404);
        await new Promise((r) => setTimeout(r, 500));
        expect(received).toEqual([]);
      } finally {
        socket.disconnect();
      }
    });
  });

  describe('4. Invitations et édition des membres', () => {
    it('invitation avec « Voir les coûts et résultats financiers » puis acceptation : droits effectifs conformes', async () => {
      const email = `invite-fin-12h-${Date.now()}@royalvibe.test`;
      const inv = await http()
        .post('/organizations/invitations')
        .set(auth(ownerA))
        .send({
          email,
          role: 'seller',
          permissions: ['products.view_financials'],
        });
      expect(inv.status).toBe(201);
      expect(inv.body.invitation.permissions).toEqual([
        'products.view_financials',
      ]);
      const token = new URL(inv.body.invitationUrl as string).searchParams.get(
        'token',
      );
      const accepted = await createInvitedAccount(
        app.getHttpServer(),
        emailSender,
        token!,
        email,
        { name: 'Invité', password: PASSWORD },
      );
      expect(accepted.status).toBe(200);
      const relog = await login(email);
      const context = await http()
        .get('/auth/context')
        .set(auth(relog.body.access_token as string));
      expect(context.body.organizationId).toBe(orgAId);
      expect(context.body.effectivePermissions).toEqual(
        expect.arrayContaining([
          'sales.record',
          'sales.view_own',
          'products.view_financials',
        ]),
      );
      expect(context.body.effectivePermissions).not.toContain(
        'products.view_stock_details',
      );
      expect(context.body.effectivePermissions).not.toContain('sales.view_all');
      expect(context.body.effectivePermissions).not.toContain('analytics.read');
    });

    it('anti-escalade : un vendeur members.invite ne peut pas accorder un groupe produit qu’il ne possède pas', async () => {
      const res = await http()
        .post('/organizations/invitations')
        .set(auth(inviterSeller.token))
        .send({
          email: `escalade-12h-${Date.now()}@royalvibe.test`,
          role: 'seller',
          permissions: ['products.view_stock_details'],
        });
      expect(res.status).toBe(403);
    });

    it('permission inconnue refusée (validation)', async () => {
      const res = await http()
        .post('/organizations/invitations')
        .set(auth(ownerA))
        .send({
          email: `inconnue-12h-${Date.now()}@royalvibe.test`,
          role: 'seller',
          permissions: ['products.view_everything'],
        });
      expect(res.status).toBe(400);
    });

    it('édition : accorder puis retirer le détail du stock change la projection au prochain contexte', async () => {
      const grant = await http()
        .patch(`/organizations/members/${sellerA.membershipId}`)
        .set(auth(ownerA))
        .send({ permissions: ['products.view_stock_details'] });
      expect(grant.status).toBe(200);
      let token = (await login('seller-a-12h@royalvibe.test', orgAId)).body
        .access_token as string;
      let res = await getProduct(token);
      expect(res.body.product.initialQuantity).toBe(10);

      const revoke = await http()
        .patch(`/organizations/members/${sellerA.membershipId}`)
        .set(auth(ownerA))
        .send({ permissions: [] });
      expect(revoke.status).toBe(200);
      token = (await login('seller-a-12h@royalvibe.test', orgAId)).body
        .access_token as string;
      res = await getProduct(token);
      expect(res.body.product).not.toHaveProperty('initialQuantity');
      // Les droits standard restent.
      expect((await sell(token, 1, 1900)).status).toBe(201);
    });
  });
});
