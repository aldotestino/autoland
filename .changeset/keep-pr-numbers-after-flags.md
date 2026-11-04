---
"@aldotestino/autoland": patch
---

Keep PR numbers 1 and 0 when they follow `--dry-run`, `--yes` or `--non-interactive`. These flags used to read them as their own value, so `--dry-run 1 2` dropped PR #1 and `--dry-run 0 2` turned the dry run off.
