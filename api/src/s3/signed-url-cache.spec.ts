import { SignedUrlCache } from './signed-url-cache';

describe('SignedUrlCache (1-20C)', () => {
  let now = 0;
  const cache = (maxEntries = 10, reuseMs = 1_000) =>
    new SignedUrlCache({ maxEntries, reuseMs, now: () => now });

  beforeEach(() => {
    now = 1_000_000;
  });

  it('réutilise une URL pendant la fenêtre, puis signe de nouveau', async () => {
    const c = cache();
    const sign = jest.fn(() => Promise.resolve(`url-${now}`));
    expect(await c.get('k', sign)).toBe('url-1000000');
    now += 999;
    expect(await c.get('k', sign)).toBe('url-1000000');
    expect(sign).toHaveBeenCalledTimes(1);
    now += 1; // fin exacte de la fenêtre : plus réutilisable
    expect(await c.get('k', sign)).toBe('url-1001000');
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it('clés distinctes : signatures distinctes', async () => {
    const c = cache();
    const sign = (v: string) => jest.fn(() => Promise.resolve(v));
    expect(await c.get('a', sign('A'))).toBe('A');
    expect(await c.get('b', sign('B'))).toBe('B');
    expect(await c.get('a', sign('autre'))).toBe('A');
  });

  it('capacité bornée : évince la moins récemment utilisée', async () => {
    const c = cache(2);
    await c.get('a', () => Promise.resolve('A'));
    await c.get('b', () => Promise.resolve('B'));
    await c.get('a', () => Promise.resolve('A2')); // lecture : « a » redevient récente
    await c.get('c', () => Promise.resolve('C')); // évince « b »
    expect(c.size).toBe(2);
    expect(await c.get('a', () => Promise.resolve('A3'))).toBe('A');
    expect(await c.get('b', () => Promise.resolve('B2'))).toBe('B2');
  });

  it('appels simultanés pour une même clé : une seule signature', async () => {
    const c = cache();
    let release: (v: string) => void = () => undefined;
    const sign = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const calls = Array.from({ length: 5 }, () => c.get('k', sign));
    release('U');
    expect(await Promise.all(calls)).toEqual(['U', 'U', 'U', 'U', 'U']);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('erreur : rien en cache, libération, nouvel essai', async () => {
    const c = cache();
    await expect(
      c.get('k', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(c.size).toBe(0);
    const sign = jest.fn(() => Promise.resolve('OK'));
    expect(await c.get('k', sign)).toBe('OK');
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('absence (null) : jamais mise en cache', async () => {
    const c = cache();
    expect(await c.get('k', () => Promise.resolve(null))).toBeNull();
    expect(c.size).toBe(0);
    expect(await c.get('k', () => Promise.resolve('OK'))).toBe('OK');
  });

  it('fenêtre nulle : aucune réutilisation', async () => {
    const c = cache(10, 0);
    const sign = jest.fn(() => Promise.resolve('U'));
    await c.get('k', sign);
    await c.get('k', sign);
    expect(sign).toHaveBeenCalledTimes(2);
    expect(c.size).toBe(0);
  });

  it('fenêtre comptée depuis le DÉBUT de la signature (borne prudente)', async () => {
    const c = cache(10, 1_000);
    await c.get('k', () => {
      now += 600; // signature lente
      return Promise.resolve('U');
    });
    now += 399; // 999 ms après le début de la signature
    const sign = jest.fn(() => Promise.resolve('V'));
    expect(await c.get('k', sign)).toBe('U');
    now += 1;
    expect(await c.get('k', sign)).toBe('V');
  });
});
