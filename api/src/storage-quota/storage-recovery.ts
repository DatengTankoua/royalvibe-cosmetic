import { Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { StorageQuotaService } from './storage-quota.service';

/**
 * 1-17B — Traitements de fond du stockage, démarrés UNIQUEMENT par le
 * processus HTTP (`main.ts`) ; les CLI ne les activent jamais. Plusieurs
 * instances peuvent tourner en parallèle : chaque transition est
 * conditionnelle à l'état attendu (aucun double comptage).
 *
 * - Reprise (`STORAGE_RECOVERY_INTERVAL_SECONDS`) : réservations et
 *   suppressions dont l'échéance est dépassée.
 * - Inventaire (`STORAGE_INVENTORY_INTERVAL_SECONDS`) : fichiers présents
 *   dans le stockage sans entrée au registre (envoi arrivé après la reprise,
 *   arrêt du processus…). Seulement en mode `enforce` : en mode `track`
 *   (initialisation, retour après rollback), l'opérateur lance et examine
 *   lui-même l'inventaire (`storage:quota inventory`), rien n'est supprimé
 *   automatiquement avant cette revue.
 *
 * Une passe à la fois par traitement ; minuteries `unref`. Renvoie la
 * fonction d'arrêt.
 */
export function startStorageRecovery(app: INestApplicationContext): () => void {
  const service = app.get(StorageQuotaService);
  const logger = new Logger('StorageRecovery');
  const timers: NodeJS.Timeout[] = [];

  const every = (seconds: number, work: () => Promise<void>) => {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void work().finally(() => {
        running = false;
      });
    }, seconds * 1000);
    timer.unref?.();
    timers.push(timer);
  };

  const recoverySeconds = service.config.recoveryIntervalSeconds;
  if (recoverySeconds === 0) {
    logger.log('Reprise automatique du stockage désactivée.');
  } else {
    every(recoverySeconds, async () => {
      try {
        const report = await service.recover({ limit: 200 });
        if (report.examined > 0) {
          logger.log(
            `Reprise : ${report.examined} examinée(s), ${report.released} libérée(s), ` +
              `${report.attached} rattachée(s), ${report.retry} à reprendre.`,
          );
        }
      } catch {
        logger.warn('Reprise du stockage impossible (nouvelle tentative).');
      }
    });
  }

  const inventorySeconds = service.config.inventoryIntervalSeconds;
  if (inventorySeconds === 0 || service.config.mode !== 'enforce') {
    logger.log(
      'Inventaire automatique du stockage inactif (désactivé ou mode track).',
    );
  } else {
    every(inventorySeconds, async () => {
      try {
        const report = await service.reconcileInventory({ apply: true });
        const found =
          (report.totals.untracked_referenced ?? 0) +
          (report.totals.untracked_unreferenced ?? 0);
        if (found > 0 || (report.totals.foreign_key ?? 0) > 0) {
          logger.warn(
            `Inventaire : ${found} fichier(s) non suivi(s) comptabilisé(s), ` +
              `${report.deleted} supprimé(s), ${report.pendingDeletion} en attente, ` +
              `${report.totals.foreign_key ?? 0} clé(s) hors schéma.`,
          );
        }
      } catch {
        logger.warn('Inventaire du stockage impossible (nouvelle tentative).');
      }
    });
  }

  return () => {
    for (const timer of timers) clearInterval(timer);
  };
}
