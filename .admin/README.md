# .admin/

Admin-local data staging area. Gitignored except for this README so we have
a documented, expected place for non-committed admin inputs.

## Conventions

- `pending-members.json` — default input file for
  `scripts/admin/seed-member.mjs`. One object or array of objects, each
  containing at minimum `email` and `name`. Example:
  ```json
  [
    {
      "email": "new-member@example.com",
      "name": "New Member",
      "handle": "newmember",
      "pronouns": "they/them"
    }
  ]
  ```
  After seeding, delete or move the file — don't keep member emails
  sitting around longer than necessary.

- `kv-dump.json` / `kv-snapshot-<date>.json` — ad-hoc exports for
  debugging. Fine to stash; don't commit.

- Anything else you want to keep locally about admin operations (notes,
  audit logs, to-do files). The directory is yours.

## What belongs here vs. in git

- **Here (gitignored)**: anything containing member emails, draft seed
  data, export dumps, your working notes.
- **Git**: the scripts themselves (`scripts/admin/*.mjs`), the ops
  runbook (`docs/ADMIN.md`), the public member rows in
  `data/members.json`.

Rule of thumb: if it would leak in a public repo, it lives here.
