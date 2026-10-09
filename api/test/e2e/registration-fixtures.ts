import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthService } from '../../src/auth/auth.service';

/**
 * 1-18E — L'inscription publique répond 202 avec un corps neutre (aucun
 * identifiant). Les suites qui ont besoin du compte et de l'organisation
 * les lisent EN BASE, sous `owner` (jamais dans le corps public) :
 * propriétaire de l'adresse après l'inscription, qu'il vienne d'être créé
 * ou qu'il existait déjà. Les envois de vérification différés sont attendus
 * (même comportement qu'avant pour les suites qui confirment
 * automatiquement les liens).
 */
export interface RegisteredOwner {
  user: { _id: string; name: string; email: string };
  organization: {
    _id: string;
    name: string;
    slug: string;
    currency: string;
    status: string;
  };
}

export type RegisterResponse = request.Response & { owner?: RegisteredOwner };

export async function findRegisteredOwner(
  app: INestApplication,
  email: string,
): Promise<RegisteredOwner | undefined> {
  const db = app.get<Connection>(getConnectionToken()).db!;
  const user = await db
    .collection('users')
    .findOne({ email: email.trim().toLowerCase() });
  if (!user) return undefined;
  const membership = await db
    .collection('organizationmemberships')
    .find({ userId: user._id, role: 'owner' })
    .sort({ _id: -1 })
    .limit(1)
    .next();
  if (!membership) return undefined;
  const organization = await db
    .collection('organizations')
    .findOne({ _id: membership.organizationId });
  if (!organization) return undefined;
  return {
    user: {
      _id: String(user._id),
      name: String(user.name),
      email: String(user.email),
    },
    organization: {
      _id: String(organization._id),
      name: String(organization.name),
      slug: String(organization.slug),
      currency: String(organization.currency),
      status: String(organization.status),
    },
  };
}

export async function postRegister(
  app: INestApplication,
  body: object,
  headers: Record<string, string> = {},
): Promise<RegisterResponse> {
  const req = request(app.getHttpServer() as App).post('/auth/register');
  for (const [name, value] of Object.entries(headers)) req.set(name, value);
  const res = await req.send(body);
  await app.get(AuthService).settleVerificationDispatches();
  const email = (body as { email?: unknown }).email;
  const owner =
    res.status === 202 && typeof email === 'string'
      ? await findRegisteredOwner(app, email)
      : undefined;
  return Object.assign(res, { owner });
}
