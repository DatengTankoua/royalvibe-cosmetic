/**
 * 1-13B : 5 demandes / 15 min par adresse normalisée (clé hachée), namespace
 * distinct de la vérification d'email (compteurs séparés). 1-18D : appliqué
 * par `AddressRequestLimiter` après la vérification Turnstile.
 */
export const PASSWORD_RESET_ADDRESS_THROTTLER = 'password-reset-address';
export const PASSWORD_RESET_RATE_LIMIT_CODE = 'PASSWORD_RESET_RATE_LIMITED';
