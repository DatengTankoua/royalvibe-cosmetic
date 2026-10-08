import { Inject, Injectable, Optional } from '@nestjs/common';

/**
 * 1-16D — protection de la génération des historiques mensuels (Excel et
 * PDF, construits en mémoire).
 *
 * Indépendante du `ThrottlerModule` partagé : une fenêtre nommée de plus y
 * imposerait une exclusion sur chaque autre contrôleur limité, sans quoi
 * leurs gardes consommeraient ce compteur. Ici, aucun autre compteur n'est
 * lu ni modifié. Mémoire d'une seule instance d'API (comme les autres
 * limitations du projet).
 *
 * - Quota par compte ET commerce sur une fenêtre fixe : 429.
 * - Borne de générations SIMULTANÉES (globale et par commerce) : 503.
 * Aucun rapport n'est jamais tronqué : une demande est servie entière ou
 * refusée, avec `Retry-After`.
 */
export interface ReportGenerationLimits {
  /** Durée de la fenêtre du quota (ms). */
  windowMs: number;
  /** Téléchargements admis par compte et commerce et par fenêtre. */
  maxPerWindow: number;
  /** Générations simultanées, toutes organisations confondues. */
  maxActiveGlobal: number;
  /** Générations simultanées d'un même commerce (Excel et PDF ensemble). */
  maxActivePerOrganization: number;
  /** `Retry-After` (s) quand la borne de simultanéité est atteinte. */
  busyRetryAfterSeconds: number;
}

/** Paramètres centralisés (valeurs de production). */
export const REPORT_GENERATION_LIMITS: Readonly<ReportGenerationLimits> =
  Object.freeze({
    windowMs: 10 * 60_000,
    maxPerWindow: 20,
    maxActiveGlobal: 3,
    maxActivePerOrganization: 2,
    busyRetryAfterSeconds: 10,
  });

export const REPORT_GENERATION_LIMITS_TOKEN = Symbol(
  'REPORT_GENERATION_LIMITS',
);
export const REPORT_GENERATION_CLOCK = Symbol('REPORT_GENERATION_CLOCK');

export const REPORT_RATE_LIMITED = 'REPORT_RATE_LIMITED';
export const REPORT_GENERATION_BUSY = 'REPORT_GENERATION_BUSY';

export type ReportGenerationDecision =
  | { admitted: true; release: () => void }
  | {
      admitted: false;
      code: typeof REPORT_RATE_LIMITED | typeof REPORT_GENERATION_BUSY;
      retryAfterSeconds: number;
    };

@Injectable()
export class ReportGenerationLimiter {
  private readonly windows = new Map<
    string,
    { startedAt: number; count: number }
  >();
  private readonly activeByOrganization = new Map<string, number>();
  private activeTotal = 0;

  constructor(
    @Optional()
    @Inject(REPORT_GENERATION_LIMITS_TOKEN)
    private readonly limits: ReportGenerationLimits = REPORT_GENERATION_LIMITS,
    @Optional()
    @Inject(REPORT_GENERATION_CLOCK)
    private readonly now: () => number = Date.now,
  ) {}

  /** Générations en cours (contrôle des verrous dans les tests). */
  get active(): number {
    return this.activeTotal;
  }

  /**
   * Admet une génération ou la refuse temporairement. En cas d'admission,
   * `release` DOIT être appelée (bloc `finally`) ; elle est idempotente.
   */
  acquire(userId: string, organizationId: string): ReportGenerationDecision {
    const now = this.now();
    this.prune(now);
    const key = `${userId}:${organizationId}`;
    const window = this.windows.get(key);
    if (window && window.count >= this.limits.maxPerWindow) {
      return {
        admitted: false,
        code: REPORT_RATE_LIMITED,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((window.startedAt + this.limits.windowMs - now) / 1000),
        ),
      };
    }
    const orgActive = this.activeByOrganization.get(organizationId) ?? 0;
    if (
      this.activeTotal >= this.limits.maxActiveGlobal ||
      orgActive >= this.limits.maxActivePerOrganization
    ) {
      // Refus de simultanéité : le quota n'est pas consommé.
      return {
        admitted: false,
        code: REPORT_GENERATION_BUSY,
        retryAfterSeconds: this.limits.busyRetryAfterSeconds,
      };
    }
    if (window) window.count += 1;
    else this.windows.set(key, { startedAt: now, count: 1 });
    this.activeTotal += 1;
    this.activeByOrganization.set(organizationId, orgActive + 1);

    let released = false;
    return {
      admitted: true,
      release: () => {
        if (released) return;
        released = true;
        this.activeTotal -= 1;
        const left = (this.activeByOrganization.get(organizationId) ?? 1) - 1;
        if (left > 0) this.activeByOrganization.set(organizationId, left);
        else this.activeByOrganization.delete(organizationId);
      },
    };
  }

  /** Fenêtres expirées retirées : mémoire bornée aux comptes récents. */
  private prune(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= this.limits.windowMs) {
        this.windows.delete(key);
      }
    }
  }
}
