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

Run (step 1):
- bun run find:tags --min-cell 4
- optional custom output: bun run find:tags -- --min-cell 4 --out data/board-tags.json

Output:
- data/board-tags.json
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

type Args = {
  minCellMatches: number;
  outFile?: string;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const productsPath = path.resolve(projectRoot, "..", "products.json");

function parseArgs(): Args {
  const defaults: Args = {
    minCellMatches: 3,
    outFile: path.resolve(projectRoot, "data", "board-tags.json"),
  };

  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--min-cell" && next) {
      defaults.minCellMatches = Number(next);
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

    if (type) {
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    }
    if (material) {
      materialCounts.set(material, (materialCounts.get(material) ?? 0) + 1);
    }
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

const args = parseArgs();
const products = loadProducts();

const tags: Tag[] = buildCandidateTags(products) as Tag[];

const uniqueTags = [...new Map(tags.map((tag) => [tag.id, tag])).values()];
const tagProducts = buildTagProducts(products, uniqueTags);
const matrix = buildIntersectionMatrix(tagProducts);

const viableTags = uniqueTags.filter((_, index) =>
  hasEnoughPairs(index, matrix, args.minCellMatches, 18),
);

console.log("Step 1: find tags");
console.log(`Products: ${products.length.toLocaleString("en-US")}`);
console.log(`Candidate tags: ${uniqueTags.length}`);
console.log(`Viable tags: ${viableTags.length}`);
for (const tag of viableTags) {
  console.log(
    `- ${tag.label}: ${tag.support.toLocaleString("en-US")} (${(tag.share * 100).toFixed(1)}%)`,
  );
}

if (args.outFile) {
  fs.mkdirSync(path.dirname(args.outFile), { recursive: true });
  fs.writeFileSync(
    args.outFile,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        minCellMatches: args.minCellMatches,
        viableTags: viableTags.map((tag) => ({
          id: tag.id,
          label: tag.label,
          family: tag.family,
          support: tag.support,
          share: tag.share,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`Saved tags file: ${args.outFile}`);
}
