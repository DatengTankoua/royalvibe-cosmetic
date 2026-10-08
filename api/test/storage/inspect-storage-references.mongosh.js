/* eslint-disable */
/**
 * Inspection EN LECTURE SEULE des références de fichiers (R2 privé).
 *
 * À lancer par l'opérateur, avec un utilisateur MongoDB en LECTURE SEULE
 * (rôle `read`) ou sur une copie restaurée — jamais par l'assistant :
 *   mongosh "<URI_LECTURE_SEULE>" --quiet \
 *     --eval 'var LEGACY_PUBLIC_BASE="<ancienne S3_PUBLIC_URL>/"' \
 *     --file api/test/storage/inspect-storage-references.mongosh.js
 *
 * Uniquement des `aggregate`/`countDocuments` : aucune écriture, aucune
 * conversion. Seuls des COMPTAGES, des identités de stockage et des HÔTES
 * sont affichés — jamais une URL complète, une clé ni un nom.
 */
const legacyBase =
  typeof LEGACY_PUBLIC_BASE === 'string' ? LEGACY_PUBLIC_BASE : null;

const hostOf = {
  $let: {
    vars: {
      m: {
        $regexFind: {
          input: { $ifNull: ['$imageUrl', ''] },
          regex: /^https?:\/\/([^/?#]+)/,
        },
      },
    },
    in: { $ifNull: [{ $arrayElemAt: ['$$m.captures', 0] }, null] },
  },
};

print('=== Produits : référence de photo ===');
printjson(
  db.products
    .aggregate([
      {
        $project: {
          corbeille: { $ne: [{ $ifNull: ['$deletedAt', null] }, null] },
          stockage: { $ifNull: ['$imageStorage', null] },
          aCle: { $eq: [{ $type: '$imageKey' }, 'string'] },
          hoteAncienneUrl: hostOf,
          ancienneBase: legacyBase
            ? {
                $eq: [
                  { $indexOfCP: [{ $ifNull: ['$imageUrl', ''] }, legacyBase] },
                  0,
                ],
              }
            : null,
          clePrefixeOk: {
            $cond: [
              { $eq: [{ $type: '$imageKey' }, 'string'] },
              {
                $eq: [
                  {
                    $indexOfCP: [
                      '$imageKey',
                      { $concat: ['organizations/', { $toString: '$organizationId' }, '/products/'] },
                    ],
                  },
                  0,
                ],
              },
              null,
            ],
          },
        },
      },
      {
        $group: {
          _id: {
            corbeille: '$corbeille',
            aCle: '$aCle',
            stockage: '$stockage',
            clePrefixeOk: '$clePrefixeOk',
            hoteAncienneUrl: '$hoteAncienneUrl',
            ancienneBase: '$ancienneBase',
          },
          n: { $sum: 1 },
        },
      },
      { $sort: { n: -1 } },
    ])
    .toArray(),
);

print('=== Organisations : logo ===');
printjson(
  db.organizations
    .aggregate([
      { $match: { logoKey: { $type: 'string' } } },
      {
        $project: {
          stockage: { $ifNull: ['$logoStorage', null] },
          prefixeOk: {
            $eq: [
              {
                $indexOfCP: [
                  '$logoKey',
                  { $concat: ['organizations/', { $toString: '$_id' }, '/branding/'] },
                ],
              },
              0,
            ],
          },
        },
      },
      { $group: { _id: { stockage: '$stockage', prefixeOk: '$prefixeOk' }, n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ])
    .toArray(),
);

print('=== Ancien module objects (non monté) ===');
printjson(
  db.objects
    .aggregate([
      { $project: { hote: hostOf } },
      { $group: { _id: '$hote', n: { $sum: 1 } } },
    ])
    .toArray(),
);
