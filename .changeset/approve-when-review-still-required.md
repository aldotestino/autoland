---
"@aldotestino/autoland": patch
---

Approve when GitHub still requires a review, even if someone else has already approved, since their approval may not satisfy a code-owner rule. Skip the approval, and leave the PR unmerged, when someone has approved and every code owner GitHub is waiting on is another person. When a review is what blocks a PR, the output now names the reviewers GitHub is waiting on.
