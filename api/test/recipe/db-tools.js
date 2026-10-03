/**
 * 1-14D.2H — Accès direct à la base ÉPHÉMÈRE de la recette (TEST).
 *
 * Connexion brute (driver, aucun modèle Mongoose : aucune création
 * implicite). Lectures pour les comptes rendus ; écritures uniquement pour
 * les actions de test explicites (expiration, suspension), documentées.
 */
'use strict';

const C = require('./recipe-common');

async function connect(uri) {
  const mongoose = C.apiRequire('mongoose');
  const connection = await mongoose
    .createConnection(C.assertRecipeUri(uri), {
      autoCreate: false,
      autoIndex: false,
    })
    .asPromise();
  return connection;
}

const oid = (id) => {
  const { Types } = C.apiRequire('mongoose');
  return new Types.ObjectId(String(id));
};

/** Expiration RÉELLE : toutes les périodes de l'organisation passent dans le passé. */
async function expireOrganization(db, organizationId) {
  const periods = await db
    .collection('subscription_periods')
    .find({ organizationId: oid(organizationId) })
    .sort({ sequence: 1 })
    .toArray();
  const base = Date.now() - 40 * 86_400_000;
  let offset = 0;
  for (const period of periods) {
    const startsAt = new Date(base + offset * 1000);
    await db
      .collection('subscription_periods')
      .updateOne(
        { _id: period._id },
        { $set: { startsAt, endsAt: new Date(startsAt.getTime() + 1000) } },
      );
    offset += 2;
  }
  return periods.length;
}

async function setOrganizationStatus(db, organizationId, status) {
  if (!['active', 'suspended'].includes(status))
    throw new Error(`statut inconnu : ${status}`);
  await db
    .collection('organizations')
    .updateOne({ _id: oid(organizationId) }, { $set: { status } });
}

/** Utilisateur, organisation(s) et rôles d'un compte, par e-mail. */
async function account(db, email) {
  const user = await db
    .collection('users')
    .findOne({ email: String(email).toLowerCase() });
  if (!user) throw new Error(`Compte introuvable : ${email}`);
  const memberships = await db
    .collection('organizationmemberships')
    .find({ userId: user._id })
    .toArray();
  const organizations = await db
    .collection('organizations')
    .find({ _id: { $in: memberships.map((m) => m.organizationId) } })
    .toArray();
  return {
    userId: String(user._id),
    email: user.email,
    memberships: memberships.map((m) => {
      const organization = organizations.find(
        (o) => String(o._id) === String(m.organizationId),
      );
      return {
        organizationId: String(m.organizationId),
        organization: organization ? organization.name : null,
        organizationStatus: organization ? organization.status : null,
        role: m.role,
        status: m.status,
      };
    }),
  };
}

/** Paiements, périodes `payment` et audits de rapprochement (sans téléphone). */
async function paymentReport(db, organizationId) {
  const filter = organizationId ? { organizationId: oid(organizationId) } : {};
  const payments = await db
    .collection('subscription_payments')
    .find(filter)
    .sort({ _id: 1 })
    .toArray();
  const rows = [];
  for (const payment of payments) {
    const periods = await db.collection('subscription_periods').countDocuments({
      source: 'payment',
      sourceReference: `payment:${payment._id}`,
    });
    const audits = await db
      .collection('subscription_payment_reconciliations')
      .find({ paymentId: payment._id })
      .project({
        operationId: 1,
        action: 1,
        beforeStatus: 1,
        afterStatus: 1,
        reasonCode: 1,
        operatorId: 1,
      })
      .toArray();
    rows.push({
      paymentId: String(payment._id),
      organizationId: String(payment.organizationId),
      provider: payment.provider,
      status: payment.status,
      open: payment.open,
      term: payment.term,
      amount: payment.amount,
      merchantReference: payment.merchantReference,
      providerReference: payment.providerReference,
      paymentPeriods: periods,
      reconciliationAudits: audits.map((a) => ({
        operationId: a.operationId,
        action: a.action,
        before: a.beforeStatus,
        after: a.afterStatus,
        reason: a.reasonCode,
        operator: a.operatorId,
      })),
    });
  }
  return rows;
}

/** Compteurs globaux utilisés par les assertions (avant / après). */
async function counters(db) {
  const [payments, paymentPeriods, audits] = await Promise.all([
    db.collection('subscription_payments').countDocuments({}),
    db.collection('subscription_periods').countDocuments({ source: 'payment' }),
    db.collection('subscription_payment_reconciliations').countDocuments({}),
  ]);
  return { payments, paymentPeriods, audits };
}

module.exports = {
  connect,
  oid,
  expireOrganization,
  setOrganizationStatus,
  account,
  paymentReport,
  counters,
};
