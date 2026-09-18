import {
  LOCAL_DEV_ORIGINS,
  OriginConfigError,
  buildOriginAllowlist,
  parseCORSOrigin,
} from './origin.helpers';

describe('origin.helpers — parseCORSOrigin', () => {
  describe('valeurs valides (dev/test)', () => {
    it('accepte une origine http simple', () => {
      expect(parseCORSOrigin('http://localhost:3000')).toEqual([
        'http://localhost:3000',
      ]);
    });

    it('accepte une origine https', () => {
      expect(parseCORSOrigin('https://royalvibe-cosmetic.vercel.app')).toEqual([
        'https://royalvibe-cosmetic.vercel.app',
      ]);
    });

    it('accepte une origine avec port explicite non standard', () => {
      expect(parseCORSOrigin('https://app.exemple.com:8080')).toEqual([
        'https://app.exemple.com:8080',
      ]);
    });

    it('accepte plusieurs origines séparées par virgule et conserve l’ordre', () => {
      expect(
        parseCORSOrigin(
          'https://app.exemple.com,https://www.exemple.com,http://localhost:3000',
        ),
      ).toEqual([
        'https://app.exemple.com',
        'https://www.exemple.com',
        'http://localhost:3000',
      ]);
    });

    it('supprime les espaces autour de chaque valeur', () => {
      expect(
        parseCORSOrigin(
          '  https://app.exemple.com , https://www.exemple.com  ',
        ),
      ).toEqual(['https://app.exemple.com', 'https://www.exemple.com']);
    });

    it('supprime le slash final (normalisation : une origine ne porte pas de chemin)', () => {
      expect(parseCORSOrigin('http://localhost:3000/')).toEqual([
        'http://localhost:3000',
      ]);
    });

    it('refuse une valeur avec chemin, même sans query ni fragment', () => {
      expect(() => parseCORSOrigin('http://localhost:3000/admin')).toThrow(
        OriginConfigError,
      );
    });

    it('refuse une valeur avec query string', () => {
      expect(() => parseCORSOrigin('http://localhost:3000?x=1')).toThrow(
        OriginConfigError,
      );
    });

    it('refuse une valeur avec fragment', () => {
      expect(() => parseCORSOrigin('http://localhost:3000#a')).toThrow(
        OriginConfigError,
      );
    });

    it('refuse une valeur avec userinfo (user:pass@)', () => {
      expect(() =>
        parseCORSOrigin('https://user:secret@app.exemple.com'),
      ).toThrow(OriginConfigError);
    });

    it('retire les doublons (même origine sous formes légèrement différentes)', () => {
      expect(
        parseCORSOrigin(
          'http://localhost:3000, http://localhost:3000 ,http://localhost:3000/',
        ),
      ).toEqual(['http://localhost:3000']);
    });
  });

  describe('valeurs refusées de façon absolue', () => {
    it('refuse le wildcard *', () => {
      expect(() => parseCORSOrigin('*')).toThrow(OriginConfigError);
    });

    it('refuse un wildcard dans une liste', () => {
      expect(() => parseCORSOrigin('https://app.exemple.com,*')).toThrow(
        OriginConfigError,
      );
    });

    it('refuse les motifs de sous-domaine (*.vercel.app)', () => {
      expect(() => parseCORSOrigin('https://*.vercel.app')).toThrow(
        OriginConfigError,
      );
    });

    it('refuse un protocole non HTTP/HTTPS (e.g. ws://)', () => {
      expect(() => parseCORSOrigin('ws://localhost:3000')).toThrow(
        OriginConfigError,
      );
    });

    it('refuse un protocole non HTTP/HTTPS (e.g. ftp://)', () => {
      expect(() => parseCORSOrigin('ftp://app.example.com')).toThrow(
        OriginConfigError,
      );
    });

    it('refuse une URL non parsable', () => {
      expect(() => parseCORSOrigin('not a url')).toThrow(OriginConfigError);
    });

    it('refuse une URL sans hôte', () => {
      expect(() => parseCORSOrigin('http://')).toThrow(OriginConfigError);
    });
  });

  describe('comportement selon l’environnement', () => {
    it('refuse une valeur vide («  ») en production', () => {
      expect(() => parseCORSOrigin('   ', 'production')).toThrow(
        OriginConfigError,
      );
    });

    it('refuse la valeur absente (undefined) en production', () => {
      expect(() => parseCORSOrigin(undefined, 'production')).toThrow(
        OriginConfigError,
      );
    });

    it('refuse la valeur absente (null) en production', () => {
      expect(() => parseCORSOrigin(null, 'production')).toThrow(
        OriginConfigError,
      );
    });

    it('refuse une liste ne contenant que des valeurs vides en production', () => {
      expect(() => parseCORSOrigin(', ,', 'production')).toThrow(
        OriginConfigError,
      );
    });

    it('retourne le fallback local limité en développement (valeur absente)', () => {
      expect(parseCORSOrigin(undefined)).toEqual([...LOCAL_DEV_ORIGINS]);
    });

    it('retourne le fallback local limité en test (valeur absente)', () => {
      expect(parseCORSOrigin(null, 'test')).toEqual([...LOCAL_DEV_ORIGINS]);
    });

    it('retourne le fallback local limité en développement (valeur vide)', () => {
      expect(parseCORSOrigin('   ')).toEqual([...LOCAL_DEV_ORIGINS]);
    });

    it('retourne le fallback local limité en développement (valeur vide avec virgules)', () => {
      expect(parseCORSOrigin(', ,')).toEqual([...LOCAL_DEV_ORIGINS]);
    });

    it('le fallback n’inclut aucun wildcard', () => {
      expect(LOCAL_DEV_ORIGINS).not.toContain('*');
    });

    it('le fallback n’inclut aucune valeur de production', () => {
      expect(LOCAL_DEV_ORIGINS).not.toContain(
        'https://royalvibe-cosmetic.vercel.app',
      );
      expect(LOCAL_DEV_ORIGINS.every((o) => o.startsWith('http://'))).toBe(
        true,
      );
    });
  });
});

describe('origin.helpers — buildOriginAllowlist', () => {
  it('accepte une origine exacte de l’allowlist', () => {
    const list = buildOriginAllowlist([
      'http://localhost:3000',
      'https://app.example.com',
    ]);
    expect(list.isAllowed('http://localhost:3000')).toBe(true);
    expect(list.isAllowed('https://app.example.com')).toBe(true);
  });

  it('refuse l’origine absente (undefined / null / chaîne vide)', () => {
    const list = buildOriginAllowlist(['http://localhost:3000']);
    expect(list.isAllowed(undefined)).toBe(false);
    expect(list.isAllowed(null)).toBe(false);
    expect(list.isAllowed('')).toBe(false);
  });

  it('refuse strictement tout domaine partiel ou sous-domaine (jamais de endsWith)', () => {
    const list = buildOriginAllowlist([
      'https://royalvibe-cosmetic.vercel.app',
    ]);
    expect(list.isAllowed('https://evil.com')).toBe(false);
    // Pas de sous-domaine :
    expect(list.isAllowed('https://sub.royalvibe-cosmetic.vercel.app')).toBe(
      false,
    );
    // Pas de suffixe simple :
    expect(
      list.isAllowed('https://royalvibe-cosmetic.vercel.app.attacker.com'),
    ).toBe(false);
    expect(
      list.isAllowed('https://attacker.com/royalvibe-cosmetic.vercel.app'),
    ).toBe(false);
  });

  it('ne s’applique jamais par wildcard (même si l’origine « ressemble »)', () => {
    const list = buildOriginAllowlist(['https://app.example.com']);
    expect(list.isAllowed('https://other-app.example.com')).toBe(false);
    expect(list.isAllowed('https://app.example.com.evil.com')).toBe(false);
  });

  it('distingue la sensibilité (http vs https) même avec le même host:port', () => {
    const list = buildOriginAllowlist(['http://localhost:3000']);
    expect(list.isAllowed('http://localhost:3000')).toBe(true);
    expect(list.isAllowed('https://localhost:3000')).toBe(false);
  });

  it('distingue le port (pas de correspondance partielle)', () => {
    const list = buildOriginAllowlist(['http://localhost:3000']);
    expect(list.isAllowed('http://localhost:30000')).toBe(false);
    expect(list.isAllowed('http://localhost:80')).toBe(false);
  });

  it('expose la liste d’origines exactes produites (pas de mutation externe)', () => {
    const origins = ['http://a.example', 'https://b.example:8443'];
    const list = buildOriginAllowlist(origins);
    expect([...list.origins]).toEqual(origins);
  });

  it('corsDelegate renvoie la liste autorisée si l’origine est exacte, sinon undefined', () => {
    const list = buildOriginAllowlist(['http://localhost:3000']);
    let captured: string[] | null | undefined;
    list.corsDelegate('http://localhost:3000', (err, v) => {
      expect(err).toBeNull();
      captured = v;
    });
    expect(captured).toEqual(['http://localhost:3000']);
    list.corsDelegate('https://evil.example', (err, v) => {
      expect(err).toBeNull();
      captured = v;
    });
    expect(captured).toBeUndefined();
  });
});
