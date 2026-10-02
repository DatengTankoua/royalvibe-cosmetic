import {
  TRUST_PROXY_MAX_ADDRESSES,
  TrustProxyConfigError,
  applyTrustProxy,
  expressTrustProxyValue,
  parseTrustProxyAddresses,
  resolveTrustProxySetting,
} from './trust-proxy';

describe('Confiance proxy (1-14D.2E)', () => {
  describe('parseTrustProxyAddresses', () => {
    it.each([
      [undefined, []],
      ['', []],
      ['   ', []],
      ['172.31.250.2', ['172.31.250.2']],
      [' 172.31.250.2 , 10.0.0.5 ', ['172.31.250.2', '10.0.0.5']],
      ['fd00::2', ['fd00::2']],
      ['::ffff:172.31.250.2', ['::ffff:172.31.250.2']],
    ])('%p → %p', (raw, expected) => {
      expect(parseTrustProxyAddresses(raw)).toEqual(expected);
    });

    it.each([
      ['172.31.250.0/29', 'plage CIDR'],
      ['loopback', 'mot-clé Express'],
      ['uniquelocal', 'mot-clé Express'],
      ['linklocal', 'mot-clé Express'],
      ['true', 'confiance globale'],
      ['*', 'joker'],
      ['172.31.250.2,', 'entrée vide'],
      [',172.31.250.2', 'entrée vide'],
      ['172.31.250.2,,10.0.0.5', 'entrée vide'],
      ['172.31.250.2 10.0.0.5', 'séparateur invalide'],
      ['172.31.250.256', 'octet invalide'],
      ['172.31.250', 'adresse partielle'],
      ['172.31.250.2abc', 'interprétation partielle'],
      ['0.0.0.0', 'adresse non spécifiée'],
      ['::', 'adresse non spécifiée'],
      ['172.31.250.2,172.31.250.2', 'doublon'],
      ['FD00::2,fd00::2', 'doublon (casse)'],
      ['nginx', 'nom d’hôte'],
      ['1', 'nombre'],
      [
        Array.from(
          { length: TRUST_PROXY_MAX_ADDRESSES + 1 },
          (_, i) => `10.0.0.${i + 1}`,
        ).join(','),
        'trop d’adresses',
      ],
    ])('%p (%s) → refusé', (raw) => {
      expect(() => parseTrustProxyAddresses(raw)).toThrow(
        TrustProxyConfigError,
      );
    });
  });

  describe('resolveTrustProxySetting', () => {
    it('défaut : aucun proxy approuvé', () => {
      expect(resolveTrustProxySetting({})).toEqual({ mode: 'none' });
      expect(
        resolveTrustProxySetting({
          TRUST_PROXY_HOPS: '0',
          TRUST_PROXY_ADDRESSES: '',
        }),
      ).toEqual({ mode: 'none' });
    });

    it('adresses exactes', () => {
      expect(
        resolveTrustProxySetting({ TRUST_PROXY_ADDRESSES: '172.31.250.2' }),
      ).toEqual({ mode: 'addresses', addresses: ['172.31.250.2'] });
    });

    it('sauts (contrat 0B.6 conservé)', () => {
      expect(resolveTrustProxySetting({ TRUST_PROXY_HOPS: '2' })).toEqual({
        mode: 'hops',
        hops: 2,
      });
    });

    it('sauts ET adresses → refusé (mutuellement exclusifs)', () => {
      expect(() =>
        resolveTrustProxySetting({
          TRUST_PROXY_HOPS: '1',
          TRUST_PROXY_ADDRESSES: '172.31.250.2',
        }),
      ).toThrow(TrustProxyConfigError);
    });

    it.each(['-1', '1.5', 'true', '1abc', '0x1', '+1', '1e3', 'NaN', ' 1 2'])(
      'TRUST_PROXY_HOPS=%p → refusé',
      (raw) => {
        expect(() =>
          resolveTrustProxySetting({ TRUST_PROXY_HOPS: raw }),
        ).toThrow();
      },
    );
  });

  describe('valeur Express et application', () => {
    it('jamais `true` ; aucune valeur pour le mode par défaut', () => {
      expect(expressTrustProxyValue({ mode: 'none' })).toBeUndefined();
      expect(expressTrustProxyValue({ mode: 'hops', hops: 1 })).toBe(1);
      expect(
        expressTrustProxyValue({
          mode: 'addresses',
          addresses: ['172.31.250.2'],
        }),
      ).toEqual(['172.31.250.2']);
    });

    it('mode par défaut : `trust proxy` n’est pas réglé', () => {
      const set = jest.fn();
      applyTrustProxy({ set }, { mode: 'none' });
      expect(set).not.toHaveBeenCalled();
    });

    it('adresses : liste EXACTE transmise (copie)', () => {
      const set = jest.fn();
      const addresses = ['172.31.250.2'];
      applyTrustProxy({ set }, { mode: 'addresses', addresses });
      expect(set).toHaveBeenCalledWith('trust proxy', ['172.31.250.2']);
      expect(set.mock.calls[0][1]).not.toBe(addresses);
    });
  });
});
