/**
 * Prueba local del parser parseEnVentaBlock (sin red).
 * node scripts/test-quiniela-parser.mjs
 */

const SELAE_SAMPLE = `
Jornada 64ª en venta
| 1. | Real Madrid - Barcelona |
| 2. | Atletico - Sevilla |
| 3. | A - B |
| 4. | A - B |
| 5. | A - B |
| 6. | A - B |
| 7. | A - B |
| 8. | A - B |
| 9. | A - B |
| 10. | A - B |
| 11. | A - B |
| 12. | A - B |
| 13. | A - B |
| 14. | A - B |
| P-15. | Pleno Home - Pleno Away |
`;

const QFI_TABLE_4COL = `
La jornada 65 de La Quiniela se disputa entre el sábado 30 y el domingo 31 de mayo de 2026.
| 1 | Castellón - Eibar | 31/05/2026 | 18:30 |
| 2 | Córdoba - Huesca | 31/05/2026 | 18:30 |
| 3 | Deportivo - Las Palmas | 31/05/2026 | 18:30 |
| 4 | Granada - Sporting | 30/05/2026 | 21:00 |
| 5 | Leganés - Mirandés | 31/05/2026 | 18:30 |
| 6 | Almería - Valladolid | 31/05/2026 | 18:30 |
| 7 | Ceuta - Albacete | 30/05/2026 | 16:15 |
| 8 | Racing S. - Cádiz | 31/05/2026 | 18:30 |
| 9 | R. Sociedad B - C. Leonesa | 31/05/2026 | 18:30 |
| 10 | R. Zaragoza - Málaga | 31/05/2026 | 18:30 |
| 11 | Burgos - Andorra FC | 31/05/2026 | 18:30 |
| 12 | México - Australia | 31/05/2026 | 03:00 |
| 13 | Japón - Islandia | 31/05/2026 | 12:25 |
| 14 | Alemania - Finlandia | 31/05/2026 | 20:45 |
| 15 | PSG - Arsenal | 30/05/2026 | 18:00 |
`;

const QFI_SAMPLE = `
## JORNADA Nº 65 Domingo, 31 de mayo de 2026
| 1 | Castellón - Eibar |
| 2 | Córdoba - Huesca |
| 3 | Deportivo - Las Palmas |
| 4 | Granada - Sporting |
| 5 | Leganés - Mirandés |
| 6 | Almería - Valladolid |
| 7 | Ceuta - Albacete |
| 8 | Racing S. - Cádiz |
| 9 | R. Sociedad B - C. Leonesa |
| 10 | R. Zaragoza - Málaga |
| 11 | Burgos - Andorra FC |
| 12 | México - Australia |
| 13 | Japón - Islandia |
| 14 | Alemania - Finlandia |
| 15 | PSG - Arsenal |
## JORNADA Nº 66
| 1 | Otro - Partido |
`;

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { parseEnVentaBlock } = await import(
  pathToFileURL(join(root, "src/services/quiniela-analyzer.js")).href
);

const selae = parseEnVentaBlock(SELAE_SAMPLE);
const qfi = parseEnVentaBlock(QFI_SAMPLE);
const qfi4 = parseEnVentaBlock(QFI_TABLE_4COL);

let ok = true;
if (selae?.jornada !== 64 || selae.rows.length !== 14) {
  console.error("FAIL SELAE", selae);
  ok = false;
}
if (qfi?.jornada !== 65 || qfi.rows[0]?.home !== "Castellón") {
  console.error("FAIL QFI jornada/fila1", qfi);
  ok = false;
}
if (qfi?.pleno15?.home !== "PSG" || qfi?.pleno15?.away !== "Arsenal") {
  console.error("FAIL QFI pleno15", qfi?.pleno15);
  ok = false;
}
if (qfi?.rows?.length !== 14 || qfi.rows.some((r) => r.order === 15)) {
  console.error("FAIL QFI main rows", qfi?.rows?.length);
  ok = false;
}
if (qfi4?.jornada !== 65 || qfi4?.pleno15?.home !== "PSG") {
  console.error("FAIL QFI tabla 4 columnas", qfi4);
  ok = false;
}

console.log(ok ? "OK parser quiniela (SELAE + quinielafutbol.info)" : "ERRORES en parser");
process.exit(ok ? 0 : 1);
