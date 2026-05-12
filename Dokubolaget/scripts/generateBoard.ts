import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCandidateTags } from "../src/boardTags";

/*
Approximate generation prompt used for this script family:
- Build a 3-step pipeline for Dokubolaget.
- Step 1: find robust tags from products.json.
- Step 2: generate seeded 3x3 boards where all cells are completable.
- Step 3: confirm one generated board by counting exact solutions in each cell.
- Keep tags objective (for example alcohol, volume, container, taste clock);
  avoid subjective dish-pairing tags.
- Output code-friendly JSON in data/ so app code can consume it directly.

Run (step 2):
- bun run generate:board --seed 2026-04-12 --min-cell 4 --attempts 5000 --boards 3

Output:
- data/generated-boards.json
*/

type Product = Record<string, unknown>;

type Tag = {
  id: string;
  label: string;
  family: string;
  support: number;
  share: number;
  predicate: (product: Product) => boolean;
};

type Board = {
  rows: Tag[];
  cols: Tag[];
  counts: number[][];
  score: number;
};

type Args = {
  seed: string;
  minCellMatches: number;
  targetLow: number;
  targetHigh: number;
  attempts: number;
  boards: number;
  outFile?: string;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const productsPath = path.resolve(projectRoot, "..", "products.json");

function parseArgs(): Args {
  const defaults: Args = {
    seed: new Date().toISOString().slice(0, 10),
    minCellMatches: 3,
    targetLow: 8,
    targetHigh: 120,
    attempts: 5000,
    boards: 3,
    outFile: path.resolve(projectRoot, "data", "generated-boards.json"),
  };

  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--seed" && next) {
      defaults.seed = next;
      index += 1;
    } else if (arg === "--min-cell" && next) {
      defaults.minCellMatches = Number(next);
      index += 1;
    } else if (arg === "--target-low" && next) {
      defaults.targetLow = Number(next);
      index += 1;
    } else if (arg === "--target-high" && next) {
      defaults.targetHigh = Number(next);
      index += 1;
    } else if (arg === "--attempts" && next) {
      defaults.attempts = Number(next);
      index += 1;
    } else if (arg === "--boards" && next) {
      defaults.boards = Number(next);
      index += 1;
    } else if (arg === "--out" && next) {
      defaults.outFile = path.resolve(projectRoot, next);
      index += 1;
    }
  }

  return defaults;
}

function loadProducts(): Product[] {
  const raw = fs.readFileSync(productsPath, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error("Expected products.json to be an array");
  }

  return parsed as Product[];
}

function hashSeed(seed: string) {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number) {
  let value = seed >>> 0;
  return function random() {
    value += 0x6d2b79f5;
    let temp = Math.imul(value ^ (value >>> 15), 1 | value);
    temp ^= temp + Math.imul(temp ^ (temp >>> 7), 61 | temp);
    return ((temp ^ (temp >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleN<T>(values: T[], count: number, random: () => number): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const temp = copy[index];
    copy[index] = copy[swapIndex];
    copy[swapIndex] = temp;
  }
  return copy.slice(0, count);
}

function countByStringField(products: Product[], field: string) {
  const counts = new Map<string, number>();
  for (const product of products) {
    const value = product[field];
    if (typeof value !== "string" || !value) {
      continue;
    }
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function topEntries(map: Map<string, number>, limit: number) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function createStringTags(
  products: Product[],
  map: Map<string, number>,
  field: string,
  family: string,
  prefix: string,
  limit: number,
  minShare: number,
  maxShare: number,
): Tag[] {
  const total = products.length;
  return topEntries(map, limit)
    .map(([value, support]) => {
      const share = support / total;
      return {
        id: `${prefix}:${value}`,
        label: `${prefix}:${value}`,
        family,
        support,
        share,
        predicate: (product: Product) => product[field] === value,
      };
    })
    .filter((tag) => tag.share >= minShare && tag.share <= maxShare);
}

function createBucketTags(
  products: Product[],
  field: string,
  family: string,
  buckets: Array<{
    key: string;
    label: string;
    test: (value: number) => boolean;
  }>,
  minShare: number,
  maxShare: number,
): Tag[] {
  const total = products.length;
  return buckets
    .map((bucket) => {
      let support = 0;
      for (const product of products) {
        const value = product[field];
        if (typeof value === "number" && bucket.test(value)) {
          support += 1;
        }
      }

      const share = support / total;
      return {
        id: `${family}:${bucket.key}`,
        label: bucket.label,
        family,
        support,
        share,
        predicate: (product: Product) => {
          const value = product[field];
          return typeof value === "number" && bucket.test(value);
        },
      };
    })
    .filter((tag) => tag.share >= minShare && tag.share <= maxShare);
}

function createTasteSymbolTags(
  products: Product[],
  limit: number,
  minShare: number,
  maxShare: number,
): Tag[] {
  const counts = new Map<string, number>();
  for (const product of products) {
    const symbols = Array.isArray(product.tasteSymbols)
      ? (product.tasteSymbols as unknown[])
      : [];
    for (const symbol of symbols) {
      if (typeof symbol === "string" && symbol) {
        counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
      }
    }
  }

  const total = products.length;
  return topEntries(counts, limit)
    .map(([symbol, support]) => {
      const share = support / total;
      return {
        id: `tasteSymbol:${symbol}`,
        label: `Taste:${symbol}`,
        family: "taste",
        support,
        share,
        predicate: (product: Product) => {
          const symbols = Array.isArray(product.tasteSymbols)
            ? (product.tasteSymbols as unknown[])
            : [];
          return symbols.some((value) => value === symbol);
        },
      } as Tag;
    })
    .filter((tag) => tag.share >= minShare && tag.share <= maxShare);
}

function normalizeContainerType(value: string | null) {
  if (!value) return null;
  const text = value.toLowerCase();
  if (text.includes("flaska")) return "Bottle";
  if (text.includes("burk")) return "Can";
  if (text.includes("box")) return "Box";
  if (text.includes("fat")) return "Keg";
  if (text.includes("påse")) return "Pouch";
  if (text.includes("papp")) return "Carton";
  if (text.includes("multipack")) return "Multipack";
  return null;
}

function normalizeContainerMaterial(value: string | null) {
  if (!value) return null;
  const text = value.toLowerCase();
  if (text.includes("glas")) return "Glass";
  if (text.includes("burk")) return "Aluminum/Metal";
  if (text.includes("pet") || text.includes("plast")) return "Plastic";
  if (text.includes("box") || text.includes("papp")) return "Paper/Cardboard";
  if (text.includes("påse")) return "Flexible/Plastic";
  if (text.includes("fat")) return "Metal/Keg";
  return null;
}

function countContainerDimensions(products: Product[]) {
  const typeCounts = new Map<string, number>();
  const materialCounts = new Map<string, number>();

  for (const product of products) {
    const packaging =
      typeof product.packagingLevel1 === "string"
        ? product.packagingLevel1
        : null;
    const bottleText =
      typeof product.bottleText === "string" ? product.bottleText : null;

    const type =
      normalizeContainerType(packaging) ?? normalizeContainerType(bottleText);
    const material =
      normalizeContainerMaterial(packaging) ??
      normalizeContainerMaterial(bottleText);

    if (type) typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    if (material)
      materialCounts.set(material, (materialCounts.get(material) ?? 0) + 1);
  }

  return { typeCounts, materialCounts };
}

function buildTagProducts(products: Product[], tags: Tag[]) {
  return tags.map((tag) => {
    const indices: number[] = [];
    for (let index = 0; index < products.length; index += 1) {
      if (tag.predicate(products[index])) {
        indices.push(index);
      }
    }
    return indices;
  });
}

function intersectCountSorted(left: number[], right: number[]) {
  let i = 0;
  let j = 0;
  let count = 0;

  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      count += 1;
      i += 1;
      j += 1;
    } else if (left[i] < right[j]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return count;
}

function buildIntersectionMatrix(tagProducts: number[][]) {
  const size = tagProducts.length;
  const matrix: number[][] = Array.from({ length: size }, () =>
    Array<number>(size).fill(0),
  );

  for (let i = 0; i < size; i += 1) {
    matrix[i][i] = tagProducts[i].length;
    for (let j = i + 1; j < size; j += 1) {
      const count = intersectCountSorted(tagProducts[i], tagProducts[j]);
      matrix[i][j] = count;
      matrix[j][i] = count;
    }
  }

  return matrix;
}

function hasEnoughPairs(
  index: number,
  matrix: number[][],
  minCellMatches: number,
  minGoodPairs: number,
) {
  let good = 0;
  for (let other = 0; other < matrix.length; other += 1) {
    if (other === index) {
      continue;
    }
    if (matrix[index][other] >= minCellMatches) {
      good += 1;
      if (good >= minGoodPairs) {
        return true;
      }
    }
  }
  return false;
}

function scoreCell(
  count: number,
  minCellMatches: number,
  targetLow: number,
  targetHigh: number,
) {
  if (count < minCellMatches) {
    return -60;
  }
  if (count >= targetLow && count <= targetHigh) {
    return 20;
  }
  if (count > targetHigh) {
    return 4;
  }
  return 8;
}

function scoreBoard(
  counts: number[][],
  minCellMatches: number,
  targetLow: number,
  targetHigh: number,
  families: Set<string>,
) {
  let score = 0;
  for (const row of counts) {
    for (const count of row) {
      score += scoreCell(count, minCellMatches, targetLow, targetHigh);
    }
    if (Math.min(...row) >= minCellMatches) {
      score += 14;
    }
  }

  for (let col = 0; col < 3; col += 1) {
    const colMin = Math.min(counts[0][col], counts[1][col], counts[2][col]);
    if (colMin >= minCellMatches) {
      score += 14;
    }
  }

  score += families.size * 10;
  return score;
}

function boardKey(rows: Tag[], cols: Tag[]) {
  const rowKey = rows
    .map((tag) => tag.id)
    .sort()
    .join("|");
  const colKey = cols
    .map((tag) => tag.id)
    .sort()
    .join("|");
  return `${rowKey}__${colKey}`;
}

const BLACKLISTED_TAG_IDS = new Set<string>([
  // Multipack is technically a container TYPE but in practice it's a packaging
  // detail that players don't reliably know per-product. Skip it entirely.
  "ContainerType:Multipack",
]);

// containerType and containerMaterial are almost perfectly correlated
// (Can ↔ Aluminum, Box ↔ Paper/Cardboard, Bottle ↔ Glass), so allowing both
// on one board makes two slots redundant. Treat them as one "container" group.
const CONTAINER_FAMILIES = new Set<string>([
  "containerType",
  "containerMaterial",
]);

function countContainerTags(tags: Tag[]) {
  let count = 0;
  for (const tag of tags) {
    if (CONTAINER_FAMILIES.has(tag.family)) {
      count += 1;
    }
  }
  return count;
}

function hasTasteTag(tags: Tag[]) {
  return tags.some((tag) => tag.family === "taste");
}

function findBoards(tags: Tag[], matrix: number[][], args: Args) {
  const random = mulberry32(hashSeed(args.seed));
  const candidates: Board[] = [];
  const seen = new Set<string>();

  const usableTags = tags.filter((tag) => !BLACKLISTED_TAG_IDS.has(tag.id));

  const rowPool = usableTags.filter((tag) => tag.family !== "container");
  const colPool = usableTags.filter((tag) => tag.family !== "taste");

  const idToIndex = new Map(tags.map((tag, index) => [tag.id, index]));

  for (let attempt = 0; attempt < args.attempts; attempt += 1) {
    const rows = sampleN(rowPool, 3, random);
    const cols = sampleN(
      colPool.filter((tag) => !rows.some((row) => row.id === tag.id)),
      3,
      random,
    );

    if (cols.length < 3) {
      continue;
    }

    // Reject boards that pick both a container type and a container material.
    if (countContainerTags([...rows, ...cols]) > 1) {
      continue;
    }

    // Require at least one taste-clock tag — they're the most interesting
    // category and were appearing too rarely. Taste tags only live in rows.
    if (!hasTasteTag(rows)) {
      continue;
    }

    const key = boardKey(rows, cols);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const counts: number[][] = [];
    let invalid = false;

    for (const row of rows) {
      const rowIndex = idToIndex.get(row.id);
      if (rowIndex == null) {
        invalid = true;
        break;
      }
      const rowCounts: number[] = [];

      for (const col of cols) {
        const colIndex = idToIndex.get(col.id);
        if (colIndex == null) {
          invalid = true;
          break;
        }

        const count = matrix[rowIndex][colIndex];
        rowCounts.push(count);
        if (count < args.minCellMatches) {
          invalid = true;
        }
      }

      counts.push(rowCounts);
    }

    if (invalid) {
      continue;
    }

    const families = new Set([...rows, ...cols].map((tag) => tag.family));
    const score = scoreBoard(
      counts,
      args.minCellMatches,
      args.targetLow,
      args.targetHigh,
      families,
    );
    candidates.push({ rows, cols, counts, score });
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, args.boards);
}

function productDisplayName(product: Product) {
  const bold =
    typeof product.productNameBold === "string" ? product.productNameBold : "";
  const thin =
    typeof product.productNameThin === "string" ? product.productNameThin : "";
  const number =
    typeof product.productNumber === "string" ? product.productNumber : "";

  const name = [bold, thin].filter(Boolean).join(" ").trim();
  if (!name && number) {
    return `#${number}`;
  }
  if (!number) {
    return name || "Unknown product";
  }
  return `${name} (${number})`;
}

function sampleProductsForCell(
  products: Product[],
  row: Tag,
  col: Tag,
  seed: string,
) {
  const matches = products.filter(
    (product) => row.predicate(product) && col.predicate(product),
  );
  const random = mulberry32(hashSeed(`${seed}:${row.id}:${col.id}`));
  return sampleN(matches, Math.min(3, matches.length), random).map(
    productDisplayName,
  );
}

function printBoard(
  board: Board,
  products: Product[],
  seed: string,
  index: number,
) {
  console.log(`\nBoard option ${index + 1}`);
  console.log(`Score: ${board.score}`);
  console.log(`Rows: ${board.rows.map((tag) => tag.label).join(" | ")}`);
  console.log(`Cols: ${board.cols.map((tag) => tag.label).join(" | ")}`);

  console.log("Counts per row");
  for (let row = 0; row < 3; row += 1) {
    console.log(`- ${board.rows[row].label}: ${board.counts[row].join(", ")}`);
  }

  console.log("Cell samples");
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const examples = sampleProductsForCell(
        products,
        board.rows[row],
        board.cols[col],
        seed,
      );
      console.log(`- ${board.rows[row].label} + ${board.cols[col].label}`);
      console.log(`  ${examples.join(" // ")}`);
    }
  }
}

function boardToJson(board: Board) {
  return {
    rows: board.rows.map((tag) => ({
      id: tag.id,
      label: tag.label,
      family: tag.family,
    })),
    cols: board.cols.map((tag) => ({
      id: tag.id,
      label: tag.label,
      family: tag.family,
    })),
    counts: board.counts,
    score: board.score,
  };
}

const args = parseArgs();
const products = loadProducts();

const tags: Tag[] = buildCandidateTags(products) as Tag[];

const uniqueTagsById = new Map<string, Tag>();
for (const tag of tags) {
  uniqueTagsById.set(tag.id, tag);
}
const uniqueTags = [...uniqueTagsById.values()];

const tagProducts = buildTagProducts(products, uniqueTags);
const matrix = buildIntersectionMatrix(tagProducts);

const viableIndices: number[] = [];
for (let index = 0; index < uniqueTags.length; index += 1) {
  if (hasEnoughPairs(index, matrix, args.minCellMatches, 18)) {
    viableIndices.push(index);
  }
}

const viableTags = viableIndices.map((index) => uniqueTags[index]);
const viableTagProducts = viableIndices.map((index) => tagProducts[index]);
const viableMatrix = buildIntersectionMatrix(viableTagProducts);

console.log("Dokubolaget board generator");
console.log(`Seed: ${args.seed}`);
console.log(`Products: ${products.length.toLocaleString("en-US")}`);
console.log(`Viable tags: ${viableTags.length}`);
console.log(`Attempts: ${args.attempts}`);

const boards = findBoards(viableTags, viableMatrix, args);
if (boards.length === 0) {
  console.log("No boards found. Try lower --min-cell or higher --attempts.");
  process.exit(0);
}

for (let index = 0; index < boards.length; index += 1) {
  printBoard(boards[index], products, `${args.seed}:${index}`, index);
}

if (args.outFile) {
  fs.mkdirSync(path.dirname(args.outFile), { recursive: true });
  fs.writeFileSync(
    args.outFile,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        seed: args.seed,
        minCellMatches: args.minCellMatches,
        targetLow: args.targetLow,
        targetHigh: args.targetHigh,
        boards: boards.map(boardToJson),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\nSaved boards file: ${args.outFile}`);
}
