import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 1-12F — Régressions des avis corrigés dans le runtime API, vérifiées sur
 * les copies RÉELLEMENT chargées par leurs consommateurs (résolution Node
 * depuis `@nestjs/platform-express` → `express` → `body-parser`, et depuis
 * `socket.io`), jamais sur une copie trouvée à la racine.
 *
 * - GHSA-2gc4-cqfq-p2gv (engine.io < 6.6.10) : régression fonctionnelle
 *   couverte en e2e (`test/socket.e2e-spec.ts`, § 9) ; ici, garde de version.
 * - GHSA-4mjr-xmp4-gh2g et GHSA-x5fp-wj9c-mxmx (qs < 6.16.0) : Stock Master
 *   n'appelle jamais `qs.stringify` et n'active jamais `comma: true`
 *   (body-parser : `allowPrototypes: true` sans `comma` ; Express 5 : query
 *   parser `simple`). Les deux charges des avis sont donc testées de façon
 *   isolée sur la copie utilisée par body-parser et Express.
 */

type Qs = {
  parse: (input: string, options?: Record<string, unknown>) => unknown;
  stringify: (input: unknown) => string;
};

/** package.json du paquet `name` tel que résolu par `req` (sans dépendre de ses `exports`). */
function packageJsonPath(req: NodeJS.Require, name: string): string {
  let dir = path.dirname(req.resolve(name));
  for (;;) {
    const candidate = path.join(dir, 'package.json');
    if (
      fs.existsSync(candidate) &&
      (JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: string })
        .name === name
    ) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`package.json introuvable : ${name}`);
    dir = parent;
  }
}

function requireFrom(req: NodeJS.Require, chain: string[]): NodeJS.Require {
  return chain.reduce(
    (current, name) => createRequire(packageJsonPath(current, name)),
    req,
  );
}

function versionOf(req: NodeJS.Require, name: string): string {
  return (
    JSON.parse(fs.readFileSync(packageJsonPath(req, name), 'utf8')) as {
      version: string;
    }
  ).version;
}

/** Comparaison semver `major.minor.patch` (versions stables uniquement). */
function atLeast(version: string, minimum: string): boolean {
  const a = version.split('.').map(Number);
  const b = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

const apiRequire = createRequire(__filename);
const expressRequire = requireFrom(apiRequire, [
  '@nestjs/platform-express',
  'express',
]);
const bodyParserRequire = requireFrom(expressRequire, ['body-parser']);
const socketIoRequire = requireFrom(apiRequire, ['socket.io']);

describe('Dépendances runtime API — avis corrigés (1-12F)', () => {
  it('engine.io chargé par socket.io ≥ 6.6.10 (GHSA-2gc4-cqfq-p2gv)', () => {
    expect(atLeast(versionOf(socketIoRequire, 'engine.io'), '6.6.10')).toBe(
      true,
    );
  });

  it.each([
    ['express', expressRequire],
    ['body-parser', bodyParserRequire],
  ])('qs chargé par %s ≥ 6.16.0', (_parent, req) => {
    expect(atLeast(versionOf(req, 'qs'), '6.16.0')).toBe(true);
  });

  describe('qs utilisé par body-parser', () => {
    const qs = bodyParserRequire('qs') as Qs;

    it('GHSA-4mjr-xmp4-gh2g : round-trip parse → stringify avec `constructor.isBuffer` non appelable ne lève pas', () => {
      // Options de parse de body-parser (urlencoded étendu) : allowPrototypes.
      const parsed = qs.parse('a[constructor][isBuffer]=x&b=1', {
        allowPrototypes: true,
      });
      expect(() => qs.stringify(parsed)).not.toThrow();
    });

    it('GHSA-x5fp-wj9c-mxmx : `a[]=` + `comma: true` respecte `arrayLimit`', () => {
      const options = {
        comma: true,
        arrayLimit: 3,
        throwOnLimitExceeded: true,
      };
      expect(() => qs.parse('a[]=1,2,3,4', options)).toThrow(RangeError);
      // Témoin : la notation simple était déjà limitée.
      expect(() => qs.parse('a=1,2,3,4', options)).toThrow(RangeError);
      // Sous la limite : accepté.
      expect(qs.parse('a[]=1,2', options)).toEqual({ a: [['1', '2']] });
    });
  });
});
