import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cert, initializeApp, type ServiceAccount } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

/*
Reads the generated-boards.json output of `bun run generate:board` and uploads
boards to Firestore at boards/{YYYY-MM-DD}, one document per target date.

When --days > 1, cycles through the available pool round-robin so each date
gets a board even if the pool is smaller than the date range.

Usage:
  bun run seed:firestore -- --date 2026-05-06
  bun run seed:firestore -- --date 2026-05-06 --days 30
  bun run seed:firestore -- --date 2026-05-06 --days 30 --boards-file data/generated-boards.json

Auth:
  Provide service account credentials via FIREBASE_SERVICE_ACCOUNT_KEY env var
  (the JSON contents, single-line). Falls back to GOOGLE_APPLICATION_CREDENTIALS
  (path) if the env var is absent.
*/

type BoardTag = {
  id: string;
  label: string;
  family: string;
};

type GeneratedBoard = {
  rows: BoardTag[];
  cols: BoardTag[];
  counts: number[][];
  score: number;
};

type GeneratedBoardFile = {
  generatedAt?: string;
  seed?: string;
  boards: GeneratedBoard[];
};

type Args = {
  date: string;
  days: number;
  boardsFile: string;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

function tomorrowUtc(): string {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + 1);
  return now.toISOString().slice(0, 10);
}

function addDaysUtc(dateKey: string, offset: number): string {
  const base = new Date(`${dateKey}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + offset);
  return base.toISOString().slice(0, 10);
}

function parseArgs(): Args {
  const defaults: Args = {
    date: tomorrowUtc(),
    days: 1,
    boardsFile: path.resolve(projectRoot, "data", "generated-boards.json"),
  };

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === "--date" && next) {
      defaults.date = next;
      i += 1;
    } else if (arg === "--days" && next) {
      defaults.days = Number(next);
      i += 1;
    } else if (arg === "--boards-file" && next) {
      defaults.boardsFile = path.isAbsolute(next)
        ? next
        : path.resolve(projectRoot, next);
      i += 1;
    }
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(defaults.date)) {
    throw new Error(`--date must be YYYY-MM-DD, got "${defaults.date}"`);
  }
  if (!Number.isInteger(defaults.days) || defaults.days < 1) {
    throw new Error(`--days must be a positive integer`);
  }

  return defaults;
}

function loadBoards(args: Args): GeneratedBoard[] {
  if (!fs.existsSync(args.boardsFile)) {
    throw new Error(
      `Boards file not found at ${args.boardsFile}. Run \`bun run generate:board\` first.`,
    );
  }

  const raw = fs.readFileSync(args.boardsFile, "utf8");
  const parsed = JSON.parse(raw) as GeneratedBoardFile;

  if (!Array.isArray(parsed.boards) || parsed.boards.length === 0) {
    throw new Error(`No boards found in ${args.boardsFile}`);
  }

  return parsed.boards;
}

function initFirebase() {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (serviceAccountJson) {
    const parsed = JSON.parse(serviceAccountJson) as ServiceAccount;
    initializeApp({ credential: cert(parsed) });
    return;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    initializeApp();
    return;
  }

  throw new Error(
    "Set FIREBASE_SERVICE_ACCOUNT_KEY (JSON contents) or GOOGLE_APPLICATION_CREDENTIALS (path).",
  );
}

async function main() {
  const args = parseArgs();
  const boards = loadBoards(args);

  if (args.days > boards.length) {
    console.warn(
      `Pool has ${boards.length} board(s); cycling round-robin across ${args.days} day(s). ` +
        `Generate more boards with \`bun run generate:board --boards N\` for unique daily puzzles.`,
    );
  }

  initFirebase();
  const db = getFirestore();
  const generatedAt = new Date().toISOString();

  const stripPredicate = (tag: any): BoardTag => ({
    id: String(tag.id),
    label: String(tag.label),
    family: String(tag.family),
  });

  const writes = [];
  for (let offset = 0; offset < args.days; offset += 1) {
    const date = addDaysUtc(args.date, offset);
    const board = boards[offset % boards.length];
    const document = {
      rows: board.rows.map(stripPredicate),
      cols: board.cols.map(stripPredicate),
      score: board.score,
      counts: board.counts,
      seed: date,
      generatedAt,
    };
    writes.push(
      db
        .collection("boards")
        .doc(date)
        .set(document, { merge: false })
        .then(() => {
          console.log(`Wrote boards/${date} (score ${board.score})`);
        }),
    );
  }

  await Promise.all(writes);
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exit(1);
});
