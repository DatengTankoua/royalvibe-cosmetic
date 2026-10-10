| Palier | VU | Débit offert → obtenu (it/s) | req/s | Route la plus lente (n, p50/p95/p99 ms) | Erreurs inattendues / refus / 429 | API cœurs (moy.) | Retard boucle p99 méd. (ms) | mongod cœurs | Lat. Mongo L/É (ms) | Travaux en attente max (âge s) | k6 cœurs | Mém. libre min (Mo) | Seuil |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline-catalog | 1 | 1 → 1 | 4 | products_list (20, 79.5/131.5/202.5) | 0 / 0 / 0 | 0.23 | 21.2 | 0.04 | 1.26 / 0 | 0 (0) | 0.02 | 487 | non |
| baseline-dashboard | 1 | 1 → 1 | 4 | sales_history (20, 199.6/324.1/345.7) | 0 / 0 / 0 | 0.32 | 70.7 | 0.16 | 4.42 / 0 | 0 (0) | 0.01 | 447 | non |
| baseline-notifications | 1 | 1 → 1 | 3 | notifications_read (20, 49/80.8/81.4) | 0 / 0 / 0 | 0.05 | 16.5 | 0.02 | 0.35 / 35.73 | 0 (0) | 0.01 | 590 | non |
| baseline-products | 1 | 1 → 1 | 1.9 | product_update (20, 68.7/109.6/110) | 0 / 0 / 0 | 0.05 | 17 | 0.04 | 0.31 / 7.3 | 11 (5) | 0 | 556 | non |
| baseline-sales | 1 | 1 → 1 | 1.2 | sales_create (20, 70.3/95.1/98) | 0 / 0 / 0 | 0.05 | 16.6 | 0.02 | 0.31 / 2.82 | 6 (5) | 0 | 452 | non |
| conc-catalog | 2 | 2 → 2 | 8 | products_list (90, 218.6/336.8/423.6) | 0 / 0 / 0 | 0.49 | 97.3 | 0.22 | 1.22 / 2.9 | 9394 (1061) | 0.03 | 571 | non |
| conc-catalog | 5 | 5 → 5 | 20 | products_list (225, 399.4/627.9/680.5) | 0 / 0 / 0 | 1.06 | 216.3 | 0.33 | 1.55 / 2.91 | 8997 (1108) | 0.04 | 618 | non |
| conc-catalog | 10 | 10 → 6.87 | 27.5 | products_list (309, 467.2/946.8/1132.2) | 0 / 0 / 0 | 1.32 | 329.8 | 0.34 | 1.81 / 3.27 | 8697 (1157) | 0.05 | 538 | débit obtenu 6.87/10 it/s ; retard de boucle p99 médian 329.8 ms |
| large-catalog | 1 | 1 → 1 | 4 | products_list (45, 329.6/447.8/581.6) | 0 / 0 / 0 | 0.58 | 273.7 | 0.15 | 4.48 / 0 | 0 (0) | 0.03 | 490 | retard de boucle p99 médian 273.7 ms |
| large-dashboard | 1 | 1 → 0.98 | 3.9 | sales_history (44, 591.7/764.8/827.4) | 0 / 0 / 0 | 0.8 | 289.7 | 0.49 | 13.33 / 0 | 0 (0) | 0.01 | 384 | retard de boucle p99 médian 289.7 ms |
| large-sales | 5 | 5 → 5 | 5.5 | sales_create (225, 57.2/113/120.7) | 0 / 0 / 0 | 0.16 | 22.8 | 0.09 | 0.28 / 5.91 | 50 (8) | 0.01 | 542 | non |
| large-sales | 10 | 10 → 10 | 10.8 | sales_create (450, 93.9/156/162.3) | 0 / 0 / 0 | 0.2 | 24.4 | 0.16 | 0.26 / 4.27 | 244 (22) | 0.02 | 450 | non |
| large-sales | 25 | 25 → 25 | 27.5 | sales_create (1125, 209/247.1/277.6) | 0 / 0 / 0 | 0.33 | 24.8 | 0.22 | 0.24 / 2.49 | 1234 (47) | 0.01 | 491 | non |
| mixed-ramp | 5 | — → 1.7 | 10.8 | sales_history (102, 216.5/504.4/1282.4) | 0 / 0 / 0 | 0.54 | 88.8 | 0.34 | 3.83 / 3.11 | 0 (0) | 0.01 | 333 | non |
| mixed-ramp | 10 | — → 3.32 | 20.2 | sales_history (110, 271.3/996.1/1260) | 0 / 0 / 0 | 0.92 | 109.8 | 0.53 | 3.18 / 2.93 | 17 (5) | 0.02 | 266 | non |
| mixed-ramp | 25 | — → 5.82 | 35.5 | analytics_monthly (97, 110.8/850/1269.7) | 0 / 0 / 0 | 1.26 | 127.3 | 0.62 | 2.14 / 2.16 | 138 (27) | 0.04 | 294 | non |
| mixed-ramp | 50 | — → 6.37 | 37.6 | product_trash (39, 738.4/2668.6/2767.7) | 0 / 0 / 0 | 1.3 | 240.8 | 0.63 | 2.47 / 1.8 | 362 (83) | 0.05 | 272 | p95 analytics_insights = 2299.3 ms ; p95 product_detail = 1526.6 ms ; p95 sales_create = 1902.6 ms ; p95 product_trash = 2668.6 ms ; p95 product_restore = 1876 ms ; p95 products_by_section = 2009.3 ms ; p95 product_update = 1764.2 ms ; p95 products_list = 2157.1 ms ; p95 sales_history = 2217.2 ms ; attente pool 400.5 ms |
| mixed-recovery | 5 | — → 1.7 | 11.1 | sales_history (102, 210.3/395/844.4) | 0 / 0 / 0 | 0.49 | 87.4 | 0.32 | 3.27 / 2.8 | 46 (19) | 0.01 | 662 | non |
| mixed-spike | 50 | — → 6.43 | 37.4 | product_trash (18, 1031/3223.4/3225.1) | 0 / 0 / 0 | 1.24 | 243.4 | 0.56 | 2.52 / 1.7 | 128 (23) | 0.04 | 708 | p95 sales_create = 2107.9 ms ; p95 products_by_section = 2118.5 ms ; p95 product_detail = 2040 ms ; p95 product_update = 2722.8 ms ; p95 analytics_monthly = 2427 ms ; p95 analytics_insights = 2120.1 ms ; p95 notifications_read = 1549.6 ms ; p95 sales_history = 2951.2 ms ; p95 products_list = 2713 ms |
| mixed-steady | 10 | — → 3.35 | 20.6 | sales_history (343, 272.7/715.3/935.7) | 0 / 0 / 0 | 0.95 | 115.5 | 0.57 | 2.65 / 3.09 | 276 (72) | 0.02 | 311 | non |
| ramp-catalog-fine | 6 | 6 → 6 | 24 | products_list (270, 263.3/467.4/519.7) | 0 / 0 / 0 | 1 | 170.3 | 0.43 | 1.63 / 2.92 | 10297 (926) | 0.04 | 651 | non |
| ramp-catalog-fine | 7 | 7 → 7 | 28 | products_list (315, 336.3/535.5/567) | 0 / 0 / 0 | 1.09 | 213.8 | 0.5 | 1.76 / 2.88 | 9947 (971) | 0.06 | 679 | non |
| ramp-catalog-fine | 8 | 8 → 8 | 32 | products_list (360, 343.7/584.1/638.8) | 0 / 0 / 0 | 1.2 | 238.2 | 0.57 | 1.92 / 2.95 | 9647 (1019) | 0.06 | 589 | non |
| ramp-catalog | 5 | 5 → 5 | 20 | products_list (225, 214.7/409.9/492.4) | 0 / 0 / 0 | 0.62 | 76.1 | 0.23 | 1.66 / 4.56 | 0 (0) | 0.04 | 365 | non |
| ramp-catalog | 10 | 10 → 8.73 | 34.9 | products_list (393, 289.3/730.6/981.7) | 0 / 0 / 0 | 1.12 | 181.5 | 0.51 | 2.03 / 0 | 0 (0) | 0.06 | 238 | débit obtenu 8.73/10 it/s ; mémoire libre 238 Mo |
| ramp-dashboard-fine | 2 | 2 → 2 | 8 | sales_history (90, 339.5/404.3/431.9) | 0 / 0 / 0 | 0.55 | 101.6 | 0.38 | 5.15 / 0 | 0 (0) | 0.01 | 395 | non |
| ramp-dashboard-fine | 3 | 3 → 3 | 12 | sales_history (135, 443.7/673.8/792.5) | 0 / 0 / 0 | 0.87 | 128.9 | 0.66 | 6.31 / 0 | 0 (0) | 0.02 | 450 | non |
| ramp-dashboard-fine | 4 | 4 → 4 | 16 | sales_history (180, 512.6/739.8/778.7) | 0 / 0 / 0 | 1.17 | 163.4 | 1 | 7.11 / 0 | 0 (0) | 0.02 | 459 | non |
| ramp-dashboard | 5 | 5 → 4.31 | 17.2 | sales_history (194, 641.8/897.2/1052.3) | 0 / 0 / 0 | 1.24 | 208.7 | 1.06 | 7.8 / 0 | 0 (0) | 0.02 | 319 | débit obtenu 4.31/5 it/s |
| ramp-notifications | 5 | 5 → 5 | 14.2 | notifications_read (191, 29.8/43.2/46.7) | 0 / 0 / 0 | 0.25 | 16.4 | 0.22 | 0.4 / 2.84 | 12076 (296) | 0.02 | 394 | non |
| ramp-notifications | 10 | 10 → 10 | 28.3 | notifications_unread (450, 60.2/112.7/128.9) | 0 / 0 / 0 | 0.28 | 18.3 | 0.23 | 0.48 / 2.78 | 11697 (340) | 0.03 | 357 | non |
| ramp-notifications | 25 | 25 → 25 | 70.2 | notifications_read (907, 123.9/189.2/311.9) | 0 / 0 / 0 | 0.46 | 26.2 | 0.32 | 0.4 / 2.57 | 11329 (385) | 0.05 | 974 | non |
| ramp-notifications | 50 | 50 → 50 | 135.4 | notifications_read (1592, 226.2/305.9/341.9) | 0 / 0 / 0 | 0.8 | 56 | 0.55 | 0.4 / 2.24 | 10997 (430) | 0.06 | 1287 | non |
| ramp-products | 5 | 5 → 5 | 12.5 | product_update (225, 57/121.4/134.5) | 0 / 0 / 0 | 0.2 | 17 | 0.15 | 0.31 / 5.95 | 3378 (131) | 0.01 | 529 | non |
| ramp-products | 10 | 10 → 10 | 27.7 | product_update (450, 88.3/161/218.6) | 0 / 0 / 0 | 0.32 | 19.4 | 0.24 | 0.32 / 2.73 | 4252 (166) | 0.02 | 470 | non |
| ramp-products | 25 | 25 → 25 | 66.7 | product_update (1125, 223.7/273/343.8) | 0 / 0 / 0 | 0.58 | 33.4 | 0.44 | 0.31 / 2.63 | 6913 (208) | 0.06 | 351 | non |
| ramp-products | 50 | 50 → 43.2 | 116.5 | product_update (1944, 628.7/923.9/969.4) | 2 / 0 / 0 | 1.06 | 78.2 | 0.72 | 0.38 / 2.69 | 12061 (258) | 0.09 | 410 | débit obtenu 43.2/50 it/s |
| ramp-sales | 5 | 5 → 5 | 5.4 | sales_cancel (20, 28.5/144/148.5) | 0 / 0 / 0 | 0.13 | 16.8 | 0.07 | 0.23 / 7.31 | 71 (13) | 0.02 | 592 | non |
| ramp-sales | 10 | 10 → 10 | 11.2 | sales_create (450, 74.5/96.7/112.5) | 0 / 0 / 0 | 0.18 | 16.3 | 0.14 | 0.23 / 1.95 | 199 (17) | 0.01 | 586 | non |
| ramp-sales | 25 | 25 → 25 | 27.9 | sales_create (1125, 197.3/298/320.5) | 0 / 0 / 0 | 0.37 | 22.8 | 0.26 | 0.26 / 1.24 | 1085 (38) | 0.02 | 341 | non |
| ramp-sales | 50 | 50 → 50 | 55.1 | sales_create (2250, 380.2/570/661.6) | 0 / 0 / 0 | 0.54 | 36.1 | 0.37 | 0.26 / 0.84 | 3238 (79) | 0.04 | 188 | mémoire libre 188 Mo |
