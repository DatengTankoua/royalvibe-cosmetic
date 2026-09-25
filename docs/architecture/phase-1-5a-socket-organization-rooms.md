# Phase 1-5A — Rooms Socket.IO par organisation

## Base et fichiers
- Base : `test/phase-1-4e-multitenant-isolation-gate` à `b1533dc`.
- Branche : `architecture/phase-1-5a-socket-organization-rooms`.
- Production (6) : gateway/module/middleware Events, services Products, Sales et Objects.
- Tests (8) : specs gateway/middleware/Products/Sales/Objects, E2E Socket.IO, Sales transaction et portail multi-tenant.
- Aucun contrat HTTP/JWT/base/frontend, schéma, index ou dépendance modifié.

## Handshake et room
- JWT `{ sub, orgId }` reste strictement validé, puis User est chargé comme avant.
- `OrganizationsService.resolveActiveContext(sub, orgId)` est appelé exactement une fois.
- Le contexte résolu issu de la membership est attaché au socket et fournit seul l'organisation de room.
- Membership absente/suspendue/révoquée ou organisation absente/suspendue : `connect_error unauthorized` uniforme, aucun contexte ni timer.
- Nom centralisé : `organization:<organizationId>`.
- `handleConnection` joint exactement cette room; contexte absent : `disconnect(true)` défensif.
- Expiration, timer `unref`, cleanup, CORS et `allowRequest` restent inchangés et verts.

## Émissions migrées
- `emitToOrganization(organizationId, event, payload)` utilise uniquement `server.to(room).emit`.
- Products : `product:created`, `product:updated`, `product:deleted`, restore → org serveur obligatoire.
- Sales : `sale:created` post-commit → org serveur obligatoire.
- Sections : aucun événement n'existait à migrer.
- Objects legacy : émissions globales supprimées, faute de tenant fiable sur ce modèle orphelin.
- La méthode publique historique `emit` est entièrement supprimée; aucun shim ou alias ne subsiste.

## Preuves
- Middleware : contexte actif attaché; cinq familles de refus uniformes; résolution appelée une fois avec sub/orgId.
- Gateway : join exact, déconnexion défensive et ciblage exclusif `server.to(room)`.
- Services : chaque événement Products/Sales reçoit l'organisation correcte; aucun événement sur rollback.
- Sondes rollback historiques : spies directs sur `emitToOrganization`; succès vérifie org + événement + payload, rollback vérifie zéro appel.
- E2E : même admin membre actif de A/B, deux JWT et deux sockets réelles.
- Mutation Produit A reçue uniquement par socket A; mutation B uniquement par socket B.
- Membership B suspendue/révoquée et organisation B suspendue refusées au handshake.
- Test d'expiration 0B.3 toujours vert.

## Validation finale
- Specs ciblées gateway/Sales : **2/2 suites, 33/33 tests**.
- E2E ciblés Sales transaction/Socket.IO : **2/2 suites, 42/42 tests**.
- `pnpm --filter api test` : **29/29 suites, 412/412 tests**.
- `pnpm --filter api test:e2e` : **4/4 suites, 117/117 tests**.
- `pnpm --filter api exec eslint "{src,apps,libs,test}/**/*.ts"` : **0 erreur, 2 avertissements préexistants** (`app.e2e-spec.ts`, `ephemeral-mongodb.ts`).
- `pnpm --filter api build` : **succès**.
- `git diff --check` : **succès**.
- Processus `mongod` résiduel : **aucun**.
- Recherche finale : ancien `EventsGateway.emit`/`gateway.emit(`/`eventsGateway.emit(`/`server.emit(` : **0 occurrence**; `server.to(room).emit` : **1 occurrence unique**.

## Risques résiduels
- Le frontend ne reconnecte pas encore le socket lors d'un switch d'organisation; reporté à la phase frontend.
- Stockage S3 tenant, permissions membership fines et révocation de sockets déjà connectées restent hors 1-5A.
- Aucun commit, push, accès Atlas ou MongoDB `27017`.
