# @mi8y/cds-langgraph-persistence

## 0.7.0

### Minor Changes

- a72a335: - Replace shipped concrete checkpoint entities with reusable CDS aspects.
  - Add `cds add langgraph-checkpointer` for generating default checkpoint entities.

### Patch Changes

- 8d39e22: Reconstruct sparse checkpoint channel values and versions from ancestor checkpoints when loading checkpoint tuples and history.
- 52db638: Updated path from `srv/` to `db/` for the generated CDS files

## 0.6.0

### Minor Changes

- dc848a7: Fix printing `cds add ...` during startup even after running the command
- 29d4178: Added transaction isolation for checkpointer mutations to avoid rollbacks in case of failure in enclosing CDS request
- 4a5b484: Add support for purging completed and expired threads. This can be either used as a utility for managed sweeping or as a plugin-managed job for single/multitenant expired checkpoint cleanup. The purge job will skip threads that are in interrupted or in-progress state (i.e. have pending writes) and will only delete threads that are completed and expired.

## 0.5.0

### Minor Changes

- 1fe9401: Add `cds add langgraph-persistence` command. This is a mandatory step after install, since the previous approach does not add the entities during build time

## 0.4.0

### Minor Changes

- 0b70f73: Made checkpoint parent as a CAP managed association

## 0.3.0

### Minor Changes

- 917885b: - Add `name` as mandatory config to run multiple agents/graphs within a single CDS app

## 0.2.0

### Minor Changes

- 50b1fb5: Add empty config options for checkpoint saver for non-breaking future support

## 0.1.0

### Minor Changes

- b630ad0: Add support for CDS v9 & v10 with tests

## 0.0.3

### Patch Changes

- f34d7c3: Fixed module exports for the package

## 0.0.2

### Patch Changes

- a03c4f7: Initial project setup
