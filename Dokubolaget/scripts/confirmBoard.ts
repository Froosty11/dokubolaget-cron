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

Run (step 3):
- bun run confirm:board --board-index 0
- optional custom board file: bun run confirm:board -- --board-file data/generated-boards.json --board-index 0

Input:
- data/generated-boards.json (from step 2)
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

type BoardFile = {
  seed: string;
  minCellMatches: number;
  boards: Array<{
    rows: Array<{ id: string; label: string; family: string }>;
    cols: Array<{ id: string; label: string; family: string }>;
    counts: number[][];
    score: number;
  }>;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const productsPath = path.resolve(projectRoot, "..", "products.json");

function parseArgs() {
  const defaults = {
    boardFile: path.resolve(projectRoot, "data", "generated-boards.json"),
    boardIndex: 0,
  };

  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--board-file" && next) {
      defaults.boardFile = path.resolve(projectRoot, next);
      index += 1;
    } else if (arg === "--board-index" && next) {
      defaults.boardIndex = Number(next);
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

    if (type) typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    if (material)
      materialCounts.set(material, (materialCounts.get(material) ?? 0) + 1);
  }

  return { typeCounts, materialCounts };
}

function productDisplayName(product: Product) {
  const bold =
    typeof product.productNameBold === "string" ? product.productNameBold : "";
  const thin =
    typeof product.productNameThin === "string" ? product.productNameThin : "";
  const number =
    typeof product.productNumber === "string" ? product.productNumber : "";

  const name = [bold, thin].filter(Boolean).join(" ").trim();
  return number ? `${name} (${number})` : name || "Unknown";
}

const args = parseArgs();
const products = loadProducts();
const boardFileRaw = fs.readFileSync(args.boardFile, "utf8");
const boardFile = JSON.parse(boardFileRaw) as BoardFile;

if (!boardFile.boards || boardFile.boards.length === 0) {
  throw new Error("No boards in board file");
}
if (args.boardIndex < 0 || args.boardIndex >= boardFile.boards.length) {
  throw new Error("board-index out of range");
}

const tags: Tag[] = buildCandidateTags(products) as Tag[];

const tagMap = new Map(tags.map((tag) => [tag.id, tag]));
const board = boardFile.boards[args.boardIndex];

const rows = board.rows.map((row) => {
  const tag = tagMap.get(row.id);
  if (!tag) throw new Error(`Unknown row tag id: ${row.id}`);
  return tag;
});

const cols = board.cols.map((col) => {
  const tag = tagMap.get(col.id);
  if (!tag) throw new Error(`Unknown col tag id: ${col.id}`);
  return tag;
});

console.log("Step 3: confirm board");
console.log(`Board file: ${args.boardFile}`);
console.log(`Board index: ${args.boardIndex}`);
console.log(`Seed: ${boardFile.seed}`);
console.log(`Min cell matches: ${boardFile.minCellMatches}`);

let totalAcrossCells = 0;
for (let rowIndex = 0; rowIndex < 3; rowIndex += 1) {
  const row = rows[rowIndex];
  const counts: number[] = [];
  for (let colIndex = 0; colIndex < 3; colIndex += 1) {
    const col = cols[colIndex];
    const matches = products.filter(
      (product) => row.predicate(product) && col.predicate(product),
    );
    counts.push(matches.length);
    totalAcrossCells += matches.length;

    const samples = matches.slice(0, 3).map(productDisplayName);
    console.log(`- ${row.label} + ${col.label}: ${matches.length} solutions`);
    console.log(`  ${samples.join(" // ")}`);
  }
  console.log(`Row ${row.label} counts: ${counts.join(", ")}`);
}

console.log(`Total solutions across all 9 cells: ${totalAcrossCells}`);
