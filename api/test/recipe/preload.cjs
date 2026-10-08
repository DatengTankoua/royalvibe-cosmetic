/**
 * 1-14D.2H — Préchargement de TOUS les processus de la recette (TEST).
 *
 * 1. Garde anti-`.env` (`env-guard.cjs`).
 * 2. Chien de garde : si le lanceur (`RECIPE_PARENT_PID`) disparaît (arrêt
 *    brutal), le processus se termine de lui-même. Aucun autre processus
 *    n'est visé : chacun ne surveille que son lanceur et ne tue que soi.
 */
'use strict';

require('./env-guard.cjs');

const parent = Number(process.env.RECIPE_PARENT_PID);
if (Number.isInteger(parent) && parent > 0 && parent !== process.pid) {
  const timer = setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch (error) {
      if (error.code !== 'EPERM') process.exit(70);
    }
  }, 2000);
  timer.unref();
}
