import {
  MEMBER_ACTIVITY_WINDOW_MS,
  MemberActivityAction,
  MemberActivityEntity,
  memberActivityGroupKey,
  memberActivitySentence,
  memberJoinedSentence,
  snapshotName,
} from './member-activity';

describe('Activité des membres — textes et regroupement (1-19A)', () => {
  const base = {
    actorName: 'Awa',
    entity: MemberActivityEntity.PRODUCT,
    action: MemberActivityAction.PURGED,
  };

  it('une cible : auteur, action et nom figé (lisible après suppression)', () => {
    expect(
      memberActivitySentence({
        ...base,
        count: 1,
        targets: [{ id: 'p1', name: 'Savon' }],
      }),
    ).toBe('Awa a supprimé définitivement le produit « Savon ».');
    expect(
      memberActivitySentence(
        { ...base, count: 1, targets: [{ id: 'p1', name: 'Soap' }] },
        'en',
      ),
    ).toBe('Awa permanently deleted product “Soap”.');
  });

  it('action groupée : une phrase récapitulative avec le nombre de cibles', () => {
    const targets = Array.from({ length: 12 }, (_, i) => ({
      id: `p${i}`,
      name: `P${i}`,
    }));
    expect(
      memberActivitySentence({
        ...base,
        action: MemberActivityAction.TRASHED,
        count: 12,
        targets,
      }),
    ).toBe('Awa a mis à la corbeille 12 produits.');
    expect(
      memberActivitySentence(
        { ...base, action: MemberActivityAction.RESTORED, count: 12, targets },
        'en',
      ),
    ).toBe('Awa restored 12 products.');
  });

  it('même cible modifiée plusieurs fois : nom et nombre de modifications', () => {
    expect(
      memberActivitySentence({
        ...base,
        action: MemberActivityAction.UPDATED,
        count: 3,
        targets: [{ id: 'p1', name: 'Savon' }],
      }),
    ).toBe('Awa a modifié le produit « Savon » (3 fois).');
  });

  it('auteur inconnu, identité visuelle, nouveau membre', () => {
    expect(
      memberActivitySentence({
        actorName: null,
        entity: MemberActivityEntity.BRANDING,
        action: MemberActivityAction.UPDATED,
        count: 2,
        targets: [{ id: null, name: null }],
      }),
    ).toBe("Un collaborateur a modifié l'identité visuelle.");
    expect(memberJoinedSentence('Bob')).toBe('Bob a rejoint votre entreprise.');
    expect(memberJoinedSentence(null, 'en')).toBe(
      'A new member joined your business.',
    );
  });

  it('aucun montant ni identifiant dans le texte', () => {
    const text = memberActivitySentence({
      ...base,
      entity: MemberActivityEntity.SALE,
      action: MemberActivityAction.CANCELLED,
      count: 1,
      targets: [{ id: '65f000000000000000000005', name: 'Savon' }],
    });
    expect(text).toBe('Awa a annulé une vente de « Savon ».');
    expect(text).not.toContain('65f0');
  });

  it('clé de regroupement : même auteur, action, cible et fenêtre fixe', () => {
    const at = (ms: number) => new Date(1_700_000_000_000 + ms);
    const key = (eventAt: Date, action = MemberActivityAction.TRASHED) =>
      memberActivityGroupKey({
        organizationId: 'o',
        actorId: 'a',
        entity: MemberActivityEntity.PRODUCT,
        action,
        eventAt,
      });
    const start =
      Math.floor(at(0).getTime() / MEMBER_ACTIVITY_WINDOW_MS) *
      MEMBER_ACTIVITY_WINDOW_MS;
    const inWindow = new Date(start + 10);
    expect(key(inWindow)).toBe(key(new Date(start + 59_000)));
    expect(key(inWindow)).not.toBe(
      key(new Date(start + MEMBER_ACTIVITY_WINDOW_MS)),
    );
    expect(key(inWindow)).not.toBe(
      key(inWindow, MemberActivityAction.RESTORED),
    );
  });

  it('noms figés bornés et nettoyés', () => {
    expect(snapshotName('  x  ')).toBe('x');
    expect(snapshotName('')).toBeNull();
    expect(snapshotName(undefined)).toBeNull();
    expect(snapshotName('a'.repeat(500))).toHaveLength(120);
  });
});
