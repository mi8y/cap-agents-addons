# Contributing

## Setup

```sh
pnpm install
```

## Scripts

| Script               | Description                      |
| -------------------- | -------------------------------- |
| `pnpm test`          | Run the test suite               |
| `pnpm lint:check`    | Run all linters without writing  |
| `pnpm lint`          | Auto-fix lint issues             |
| `pnpm format:check`  | Check formatting without writing |
| `pnpm format`        | Format source files              |
| `pnpm changeset`     | Wizard-based changeset creation  |
| `pnpm release:check` | Check npm release readiness      |

See [Releasing packages](docs/releasing.md) before adding a new public package or changing the repository/workflow identity used by npm Trusted Publishing.

## Style Guides

- While raising a pull-request, ensure that
  - PR title follows the [Conventional Commit](https://www.conventionalcommits.org/en/v1.0.0/) format.
  - Build is passing - `pnpm build` before committing.
  - All unit tests are passing - `pnpm test` before committing.
  - All integration tests are passing - `cd tests/integration && sh run.sh` before committing.
  - Code is formatted - `pnpm format` and linted - `pnpm lint` before committing.
  - Ensure the code is well documented
  - Ensure the code is well tested and test coverage is not reduced.
  - _Optionally_, a changeset `pnpm changeset` is created . If you are unsure, you can skip this step and the maintainers will create a changeset for you.

## Behaviour

- The changeset bot will listen for pull requests being opened and pull requests that have been updated, upon which it will then scan through the files for a changeset that has been added. If not, it will comment on the pull request to remind the contributor to add a changeset.
