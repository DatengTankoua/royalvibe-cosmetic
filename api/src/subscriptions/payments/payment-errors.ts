import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

/** 1-14D.2B — Codes STABLES des routes de paiement (aucune donnée interne). */
export const PAYMENT_ERROR_CODES = Object.freeze({
  SERVICE_UNAVAILABLE: 'PAYMENT_SERVICE_UNAVAILABLE',
  STATUS_UNAVAILABLE: 'PAYMENT_STATUS_UNAVAILABLE',
  CONFIRMATION_PENDING: 'PAYMENT_CONFIRMATION_PENDING',
  ALREADY_PENDING: 'PAYMENT_ALREADY_PENDING',
  OPERATION_CONFLICT: 'PAYMENT_OPERATION_CONFLICT',
  NOT_FOUND: 'PAYMENT_NOT_FOUND',
  INVALID_PAYER_PHONE: 'INVALID_PAYER_PHONE',
  UNEXPECTED_BODY: 'UNEXPECTED_BODY',
} as const);

export const paymentServiceUnavailable = () =>
  new ServiceUnavailableException({
    code: PAYMENT_ERROR_CODES.SERVICE_UNAVAILABLE,
    message: 'Le paiement est momentanément indisponible.',
  });

export const paymentStatusUnavailable = () =>
  new ServiceUnavailableException({
    code: PAYMENT_ERROR_CODES.STATUS_UNAVAILABLE,
    message:
      'Impossible de vérifier ce paiement pour le moment. Réessayez plus tard.',
  });

/**
 * Succès vérifié mais transaction non aboutie dans le budget (ou contention
 * persistante) : TEMPORAIRE. Aucun changement d'état, aucune nouvelle
 * collecte ; une confirmation ultérieure retrouve un éventuel commit.
 */
export const paymentConfirmationPending = () =>
  new ServiceUnavailableException({
    code: PAYMENT_ERROR_CODES.CONFIRMATION_PENDING,
    message:
      'Paiement en cours de confirmation. Vérifiez de nouveau dans un instant.',
  });

/** Autre demande alors qu'un paiement reste ouvert (id de ce paiement). */
export const paymentAlreadyPending = (paymentId: string) =>
  new ConflictException({
    code: PAYMENT_ERROR_CODES.ALREADY_PENDING,
    message: 'Un paiement est déjà en cours pour ce commerce.',
    paymentId,
  });

/** `clientOperationId` déjà utilisé pour une demande différente. */
export const paymentOperationConflict = () =>
  new ConflictException({
    code: PAYMENT_ERROR_CODES.OPERATION_CONFLICT,
    message: 'Cette opération a déjà été utilisée pour une autre demande.',
  });

/** 404 UNIFORME : inexistant, autre organisation ou identifiant invalide. */
export const paymentNotFound = () =>
  new NotFoundException({
    code: PAYMENT_ERROR_CODES.NOT_FOUND,
    message: 'Paiement introuvable.',
  });

export const invalidPayerPhone = () =>
  new BadRequestException({
    code: PAYMENT_ERROR_CODES.INVALID_PAYER_PHONE,
    message: 'Numéro Mobile Money camerounais invalide.',
  });

export const unexpectedBody = () =>
  new BadRequestException({
    code: PAYMENT_ERROR_CODES.UNEXPECTED_BODY,
    message: 'Aucun paramètre attendu.',
  });
