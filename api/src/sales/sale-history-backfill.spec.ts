import { AuditAction } from '../audit/schemas/audit-log.schema';
import {
  HistoryTrace,
  confirmedLastKnown,
  parseBackfillArguments,
} from './sale-history-backfill';

const audit = (
  action: AuditAction,
  details: Record<string, unknown> | null,
): HistoryTrace => ({ kind: 'audit', action, details });
const sale = (productName: string): HistoryTrace => ({
  kind: 'sale',
  productName,
});

/**
 * 1-15D — seules les valeurs réellement ENREGISTRÉES sont figées : `created`,
 * `deleted`, nom d'une vente. Les `name_changed` / `price_changed` /
 * `section_changed` sont journalisés AVANT l'enregistrement du produit (qui
 * peut échouer) : simples tentatives.
 */
describe('confirmedLastKnown (1-15D)', () => {
  it('aucune modification : valeurs de création confirmées', () => {
    expect(
      confirmedLastKnown([
        audit(AuditAction.CREATED, { name: 'Initial', purchasePrice: 100 }),
        audit(AuditAction.SOLD, { quantity: 2, salePrice: 400 }),
        audit(AuditAction.STOCK_CHANGED, { added: 3 }),
      ]),
    ).toEqual({ name: 'Initial', unitCost: 100 });
  });

  it('modification journalisée puis enregistrement refusé, sans confirmation : nom et prix inconnus (jamais la valeur refusée)', () => {
    expect(
      confirmedLastKnown([
        audit(AuditAction.CREATED, { name: 'Initial', purchasePrice: 100 }),
        audit(AuditAction.NAME_CHANGED, {
          name: { from: 'Initial', to: 'Refusé' },
        }),
        audit(AuditAction.PRICE_CHANGED, {
          name: { from: 'Initial', to: 'Refusé' },
          purchasePrice: { from: 100, to: 999 },
        }),
      ]),
    ).toEqual({});
  });

  it('tentative puis corbeille : nom RÉEL confirmé par `deleted` ; prix toujours inconnu', () => {
    expect(
      confirmedLastKnown([
        audit(AuditAction.CREATED, { name: 'Initial', purchasePrice: 100 }),
        audit(AuditAction.NAME_CHANGED, {
          name: { from: 'Initial', to: 'Refusé' },
        }),
        audit(AuditAction.PRICE_CHANGED, {
          purchasePrice: { from: 100, to: 999 },
        }),
        audit(AuditAction.DELETED, { name: 'Initial' }),
      ]),
    ).toEqual({ name: 'Initial' });
  });

  it('renommage abouti : confirmé par une vente postérieure ou par la corbeille', () => {
    const rename = audit(AuditAction.NAME_CHANGED, {
      name: { from: 'A', to: 'B' },
    });
    const created = audit(AuditAction.CREATED, {
      name: 'A',
      purchasePrice: 50,
    });
    expect(confirmedLastKnown([created, rename, sale('B')])).toEqual({
      name: 'B',
      unitCost: 50,
    });
    expect(
      confirmedLastKnown([
        created,
        rename,
        audit(AuditAction.DELETED, { name: 'B' }),
      ]),
    ).toEqual({ name: 'B', unitCost: 50 });
    // Vente ANTÉRIEURE à la tentative : ne la confirme pas.
    expect(confirmedLastKnown([created, sale('A'), rename])).toEqual({
      unitCost: 50,
    });
  });

  it('changement de prix cumulé dans `section_changed` : tentative aussi', () => {
    expect(
      confirmedLastKnown([
        audit(AuditAction.CREATED, { name: 'X', purchasePrice: 10 }),
        audit(AuditAction.SECTION_CHANGED, {
          purchasePrice: { from: 10, to: 12 },
          sectionId: { from: 'a', to: 'b' },
        }),
      ]),
    ).toEqual({ name: 'X' });
  });

  it('les valeurs `from` ne confirment jamais seules', () => {
    expect(
      confirmedLastKnown([
        audit(AuditAction.PRICE_CHANGED, {
          purchasePrice: { from: 100, to: 150 },
        }),
      ]),
    ).toEqual({});
  });

  it('valeurs invalides ignorées ; prix d’achat 0 accepté', () => {
    expect(
      confirmedLastKnown([
        audit(AuditAction.CREATED, { name: '  ', purchasePrice: 0 }),
        audit(AuditAction.NAME_CHANGED, { name: { to: '' } }),
        audit(AuditAction.PRICE_CHANGED, { purchasePrice: { to: -1 } }),
        audit(AuditAction.DELETED, null),
      ]),
    ).toEqual({ unitCost: 0 });
  });

  it('aucune trace exploitable → rien (aucune valeur inventée)', () => {
    expect(confirmedLastKnown([])).toEqual({});
  });
});

describe('parseBackfillArguments (1-15D)', () => {
  it('simulation par défaut', () => {
    expect(parseBackfillArguments([])).toEqual({ apply: false });
  });

  it('--apply et organisation explicites', () => {
    expect(
      parseBackfillArguments([
        '--organization-id=aaaaaaaaaaaaaaaaaaaaaaaa',
        '--apply',
      ]),
    ).toEqual({ apply: true, organizationId: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
  });

  it('organisation invalide ou argument inconnu → erreur', () => {
    expect(parseBackfillArguments(['--organization-id=x'])).toHaveProperty(
      'error',
    );
    expect(parseBackfillArguments(['--force'])).toHaveProperty('error');
    expect(parseBackfillArguments(['apply'])).toHaveProperty('error');
  });
});
