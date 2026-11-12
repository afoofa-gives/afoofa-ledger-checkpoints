# afoofa ledger checkpoints

afoofa records every dollar given and every vote cast in a public, tamper-evident ledger. Each entry carries a cryptographic hash of its own contents and of the entry before it, so changing any past entry breaks every entry after it.

Once a day, afoofa commits a **checkpoint** here: the id and hash of the newest ledger entry. GitHub's commit history is a timestamp afoofa can't rewrite, so a checkpoint fixes the ledger as it stood that day. If anyone later changed an earlier entry, its hash would no longer lead to the checkpoint's hash.

This repository holds:

- `checkpoints/<chain>/YYYY/MM/YYYY-MM-DD.json`: one checkpoint per day, as `{ "chain", "date", "entryId", "hash" }`.
- `verify.mjs`: a self-contained verifier. It needs Node.js 22 or later and nothing else, and makes no network requests unless you ask it to.

The chain named `test` holds test-mode gifts from before launch. Real gifts will start a new chain, `live`.

## Verify the ledger yourself

1. **Download the ledger.** On afoofa's [transparency page](https://afoofa-platform.vercel.app/transparency), download each monthly ledger file (for example `2026-11.json`).
2. **Download the verifier and a checkpoint** from this repository: `verify.mjs`, and the newest file under `checkpoints/`.
3. **Run it:**

   ```bash
   node verify.mjs 2026-10.json 2026-11.json --checkpoint 2026-11-06.json
   ```

   It prints the number of entries, the newest entry's id and hash, whether the checkpoint matched, and `OK: the export verifies`, or the first problem it finds and `FAILED.`

   It can also download the monthly files itself: `node verify.mjs --site https://afoofa-platform.vercel.app --checkpoint <file>`.

To see it catch a change, edit a number in one of the files (an entry's `amountCents`, say) and run it again: it fails at that entry.

## What it checks

- **The chain:** every entry's hash matches its contents, and links to the entry before it.
- **The checkpoint:** the entry with the checkpoint's id has the checkpoint's hash.
- **The rules,** when every entry is in the current format: no one gives more than $365 in a rolling year, no one casts more votes than they've received, each cycle's tally matches its votes, and pools and ties are split as stated.
- **Matching grants:** each match is exactly what its published pledge allows (its ratio of the dollars Agents of Change brought into that month's pool, up to its ceiling and the partner's balance, less the operator fee), and no partner is returned more than its balance.

Names, email addresses and payment references are never published. Each giver appears under a pseudonym, and the private fields of each entry are sealed under a hash that the giver's own receipt can open. Entries from before the current format show only their id, links and hash.

## Licence

MIT, © AFOOFA Inc. See `LICENSE`.
