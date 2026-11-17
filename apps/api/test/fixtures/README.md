# T-112: public-source parser fixtures

Captured 2026-11-17 with a public GET and no account or credentials. These are reduced snapshots for offline parser regression checks, not live source monitoring. Job details can become stale.

- `itviec.html`: one job-card excerpt from https://itviec.com/it-jobs/java/ho-chi-minh-hcm (card capped at 9,000 characters).
- `topdev.html`: one matching job record from https://topdev.vn/jobs/search?keyword=Java (source escaped quotes flattened, excerpt capped at 12,000 characters).
- `wwr.xml`: first item from https://weworkremotely.com/categories/remote-programming-jobs.rss wrapped in a minimal RSS container.
- `remotive.json`: one job from https://remotive.com/api/remote-jobs?category=software-dev&limit=200, description truncated at 2,000 characters.
- `remoteok.json`: one job from https://remoteok.com/api, description truncated at 2,000 characters. Source: Remote OK.
- `hn-search.json` and `hn-item.json`: the newest matching Who is hiring search result and one matching remote engineering comment from https://hn.algolia.com/api; comment truncated at 2,000 characters.

Run `node apps/api/test/source-fixtures.selfcheck.cjs apps/api/src/worker.js`. These snapshots do not establish that external sources work today or detect a later website change without refreshing them.