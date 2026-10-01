# Decisions

- Approved direction: the user's two rules supersede broader optional research ideas. Implement scoped references first, automated owner updates second.
- Size/risk: large/high because three repositories and multiple packaging ecosystems are involved. Split ownership by repository and by Capture application/package code versus release tooling.
- Existing owner first: retain Capture release/version.json, Cert public version facade, LAW consistency checker/stager. Add only small data/readers where cross-language or standalone packaging needs them.
- Do not migrate release infrastructure, merge Cargo workspaces, widen dependency ranges, weaken schema literals, or alter model approvals.
- Preserve native metadata where package managers need concrete values. Recompute derived data using its existing owner; do not regex-rewrite lockfile checksums or historical evidence.
- Consumer implementation is prepared in private temporary clones because sibling repositories are outside the writable root. Apply concrete reviewed patches through the required sandbox approval boundary.
- No repository-local pre-implementation review gate was found. Prior independent research review supports the direction; fresh independent implementation review is required before handoff.
