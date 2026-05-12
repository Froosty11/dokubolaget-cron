# dokubolaget-seed

Stand-alone "headless" slice of the Dokubolaget repo, containing **only** what's needed for the nightly board-seeding cron to run on github.com Actions. The React Native app itself lives in the main course repo on KTH GHE.

## Why this exists

KTH GHE (`gits-15.sys.kth.se`) does not have GitHub Actions runners enabled (or at minimum, has not historically been reliable for course projects). github.com Actions is free and works. This folder is the minimum subset that needs to live on github.com.

The runtime app (Expo / React Native / Tamagui / Firebase auth) is **not** in this repo. It stays on KTH GHE.

## Workflow

`.github/workflows/seed-board.yml` runs nightly at 22:00 UTC and:

1. Fetches a fresh product catalog from `https://susbolaget.emrik.org/v1/products`.
2. Runs `bun run find:tags` to compute viable Dokubolaget tags.
3. Runs `bun run generate:board` to pick the next day's board.
4. Runs `bun run seed:firestore` to write `boards/{YYYY-MM-DD}` to Firestore using the `FIREBASE_SERVICE_ACCOUNT_KEY` secret.

The runtime app reads from `boards/{today}` in Firestore on startup. See `Dokubolaget/scripts/SEED-BOARD-PROD-SETUP.md` for the end-to-end enablement walkthrough.

## What's in here

```
.github/workflows/seed-board.yml      # cron + manual trigger
Dokubolaget/
  scripts/
    findTags.ts                       # step 1: tag mining from products.json
    generateBoard.ts                  # step 2: pick a 3x3 board
    confirmBoard.ts                   # step 3 (dev only): re-verify cell counts
    seedFirestoreBoard.ts             # step 4: write boards/{date} to Firestore
    README.md                         # script-by-script documentation
    SEED-BOARD-PROD-SETUP.md          # production enablement checklist
  src/
    boardTags.ts                      # shared tag definitions + predicates
  data/
    board-tags.json                   # cached viable-tag set; regenerated each run
  package.json                        # slim — firebase-admin only
  tsconfig.json
```

## Sync model

When you update tag logic or scripts in the main repo, copy the changed file into this mirror and commit. The two repos drift if you forget — keep the touch-points small (`scripts/*.ts`, `src/boardTags.ts`) to make that easy.

A nice future improvement: a GitHub Action on the main repo that auto-pushes the relevant subset here on every merge to `main`. Not built yet.

## Local quick run (optional)

```bash
cd Dokubolaget
bun install
curl -o ../products.json https://susbolaget.emrik.org/v1/products
bun run find:tags --min-cell 4
bun run generate:board --seed $(date -u +%F) --boards 1
# requires FIREBASE_SERVICE_ACCOUNT_KEY env var or GOOGLE_APPLICATION_CREDENTIALS file path
bun run seed:firestore --date $(date -u -d 'tomorrow' +%F)
```

## License / IP notes

`susbolaget.emrik.org` is a community mirror of Systembolaget's public catalog. The board pipeline only uses publicly available product metadata. Generated boards are derived data and are stored in Firestore under our own project.
