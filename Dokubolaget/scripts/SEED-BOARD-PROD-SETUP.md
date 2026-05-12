# Daily Board Cron — Production Setup

End-to-end checklist to get `.github/workflows/seed-board.yml` running nightly against the production Firestore. Assumes you're starting from a fresh clone with no automation set up yet.

Time estimate: 15–20 minutes the first time.

---

## 1. Mirror the repo to github.com

KTH GHE (`gits-15.sys.kth.se`) is unlikely to have Actions runners enabled. The workflow runs on `ubuntu-latest` which is a github.com-hosted runner. Easiest path: push the repo to a regular github.com account too.

```bash
# Create an empty private repo on github.com first (UI → "New repository").
# Then, from the project root:
git remote add github https://github.com/<your-user>/<your-repo>.git
git push github main
```

You now have two remotes: `origin` (KTH GHE) for course submission, `github` (github.com) for Actions. Keep pushing to both as you commit:

```bash
git push origin main && git push github main
```

If you'd rather, set up an Action on the GHE side that just mirrors the branch to github.com on every push — but it's overkill for a course project.

---

## 2. Create a Firebase service account

This is the credential the workflow uses to write to Firestore.

1. Open the [Firebase console](https://console.firebase.google.com/).
2. Pick the Dokubolaget project.
3. ⚙️ (top left) → **Project settings** → **Service accounts** tab.
4. Click **Generate new private key**. Confirm. A JSON file downloads. **Treat this like a password — never commit it.**
5. (Recommended) Scope it down: open the [Google Cloud IAM console](https://console.cloud.google.com/iam-admin/iam) for the same project. Find the service account you just created (looks like `firebase-adminsdk-xxxxx@<project>.iam.gserviceaccount.com`). Grant it **Cloud Datastore User** only, and remove any broader Firebase Admin / Editor roles. This limits blast radius if the key leaks.

---

## 3. Add the secret to github.com

1. github.com repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
2. Name: `FIREBASE_SERVICE_ACCOUNT_KEY` (exact spelling — the workflow references this name).
3. Value: open the JSON file from step 2 in a text editor, copy the **entire** contents (including the outer `{` and `}`), paste it into the value field.
4. Click **Add secret**.

---

## 4. Trigger a manual run to verify

Before letting cron loose, run it once by hand to catch any setup mistakes.

1. github.com repo → **Actions** tab.
2. Left sidebar → **Seed daily board to Firestore**.
3. **Run workflow** button (top right) → leave inputs blank → **Run workflow**.
4. Watch the logs. The four steps to watch:
   - **Fetch fresh products.json** → should report a ~100 MB file size.
   - **Find candidate tags** → prints tag counts, ends with "Saved tags file: …board-tags.json".
   - **Generate board for target date** → prints one board with rows/cols/cell samples.
   - **Upload board to Firestore** → prints `Wrote boards/<tomorrow's date> (score N)`.
5. If all green, open the [Firestore console](https://console.firebase.google.com/) → **Firestore Database** → `boards` collection. There should be a doc at `boards/<tomorrow-YYYY-MM-DD>` with `rows`, `cols`, `counts`, `score`, `seed`, `generatedAt`.

---

## 5. Confirm the app reads from Firestore

The runtime in `Dokubolaget/src/dokuModel.ts` does:

1. Start with a deterministic board from the bundled `data/generated-boards.json` (so first paint is instant and offline-tolerant).
2. Kick off `loadDailyBoardFromFirestore()` in the background — replaces the board with `boards/{today}` if the document exists.

To verify it's actually swapping:

1. Run the app: `bun run dev` from `Dokubolaget/`.
2. Open the page that renders the board.
3. In the browser console: `__sb.model.boardSource` — should read `"firestore"` after the fetch resolves.
4. If it stays `"local"`, check:
   - Is there a `boards/<today>` doc in Firestore? (The workflow seeds **tomorrow**'s board on each run, so the first nightly run only helps users on day N+1.)
   - Open Network tab → look for a Firestore RPC. Watch for permission errors (Firestore rules) or "document does not exist".

---

## 6. Let cron take over

Already done — `schedule: 0 22 * * *` is enabled in the workflow. Every day at 22:00 UTC the workflow:

1. Spins up an `ubuntu-latest` runner.
2. Curl-fetches `https://susbolaget.emrik.org/v1/products`.
3. Runs `find:tags` → `generate:board --boards 1 --seed <tomorrow>`.
4. Runs `seed:firestore --date <tomorrow>` to write `boards/<tomorrow>`.

You should see one run per day in the Actions tab. If a run fails, GitHub emails you (assuming you have notifications on for the repo).

---

## 7. Firestore security rules (don't skip)

By default, Firestore in test mode allows anyone with the project ID to read/write everything. The seed workflow needs write to `boards/*` from a service account; the app needs read.

Minimum rule set for `boards/*`:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /boards/{date} {
      allow read: if true;        // public — every player needs today's board
      allow write: if false;      // only the seed workflow's service account writes
    }
    // ... keep your existing user-doc rules
  }
}
```

The service account bypasses these rules (it's authenticated through the Admin SDK, not as a "user"), so `allow write: if false` does NOT block the workflow. Test this in the Firestore Rules Playground before publishing.

---

## Troubleshooting cheatsheet

| Symptom | Likely cause |
|---|---|
| Workflow fails at "Fetch fresh products.json" | susbolaget.emrik.org is down. Rerun in an hour; if persistent, fall back to a committed snapshot for the day. |
| Workflow fails at "Upload board to Firestore" with `permission-denied` | The service account doesn't have Cloud Datastore User. Re-check IAM in step 2. |
| Workflow fails with "FIREBASE_SERVICE_ACCOUNT_KEY is not defined" | Secret name typo, or the secret is set at the **organization** level when the workflow expects a **repository** secret. |
| Workflow runs green but Firestore stays empty | The Firebase project ID embedded in `FIREBASE_SERVICE_ACCOUNT_KEY` doesn't match the project Firestore is in. |
| App's `boardSource` stays `"local"` even after a seed | The current-day doc is missing. The workflow seeds **tomorrow's** board — today's only exists if someone backfilled it (e.g. `seed:firestore --date <today>` from local). |
