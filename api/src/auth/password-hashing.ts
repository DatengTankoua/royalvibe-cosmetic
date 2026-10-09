import { randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';

/**
 * Coût bcrypt des mots de passe (inscription, invitation, réinitialisation :
 * 10 partout depuis 0B/1-13B).
 */
export const PASSWORD_HASH_ROUNDS = 10;

let dummyHash: Promise<string> | undefined;

/**
 * 1-18C — Empreinte FACTICE (même algorithme, même coût), calculée une fois
 * par processus depuis un secret aléatoire jamais conservé. Pour un compte
 * inconnu, `verifyCredentials` la compare au mot de passe reçu : le travail
 * bcrypt est alors du même ordre que pour un compte existant. Ce n'est pas
 * un temps constant garanti (lecture en base, ordonnancement) et aucun
 * délai artificiel n'est ajouté.
 */
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= bcrypt.hash(
    randomBytes(32).toString('base64url'),
    PASSWORD_HASH_ROUNDS,
  );
  return dummyHash;
}
