# Contributing to TaskX

Thanks for wanting to help. TaskX is small on purpose: one floating panel, one JSON file, no accounts. Contributions that keep it that way are the ones most likely to land.

## Opening an issue

Search the [open issues](https://github.com/gaderOussama/TaskX/issues) first; if yours is already there, add a 👍 or a comment with new detail instead of a duplicate.

Then open a [new issue](https://github.com/gaderOussama/TaskX/issues/new/choose) and pick a template:

- **Bug report** — what you did, what you expected, what happened instead. Include your Windows version, the TaskX version, and a screenshot if it is visual. If it involves your data, attach a copy of `%APPDATA%\taskx\data.json` only after removing anything private.
- **Feature request** — the problem you are trying to solve first, the idea second. "I lose track of X when Y" is more useful than "add a button for Z".

Security problems: do not open a public issue. Use GitHub's [private vulnerability report](https://github.com/gaderOussama/TaskX/security/advisories/new) instead.

## Asking for a pull request

1. **Talk first for anything bigger than a small fix.** Open an issue (or comment on an existing one) describing what you want to change and wait for a maintainer to agree on the approach. This saves you from building something that will not be merged.
2. Small fixes — typos, an obvious bug, a one-file change — can go straight to a PR.
3. Say in the issue that you want to take it, so two people do not build the same thing.

## Development workflow

`master` is protected: nobody pushes to it directly, every change goes through a pull request.

1. **Fork** the repository and clone your fork.
2. **Set up**: install the Rust toolchain, the MSVC build tools and Node.js, then run `npm install`.
3. **Branch** from an up-to-date `master`, one branch per change:
   - `fix/<short-name>` for bugs
   - `feat/<short-name>` for features
   - `docs/<short-name>` for documentation
4. **Build and run** with `npm run dev`. Try your change in the tile, the card and the dashboard.
5. **Test** with `npm test`. Add a test when you change the storage layer (`src-tauri/src/store.rs`) or the easing curve; the tests must pass before review.
6. **Commit** in small, focused commits using [Conventional Commits](https://www.conventionalcommits.org/): `fix(panel): …`, `feat(ui): …`, `docs: …`. The subject says what changed; the body says why.
7. **Push** to your fork and open a pull request against `master`. Fill in the template, link the issue (`Closes #12`), and add a screenshot or short clip for anything visual.
8. **Review**: a maintainer reviews every PR. Answer comments by pushing new commits to the same branch; do not open a new PR. Once approved, the maintainer merges it.

## Rules

- **Human contributors only.** Every commit must be authored by a person, and no AI tool, bot or assistant may appear as an author or co-author. Remove trailers such as `Co-Authored-By: <AI tool>` before you push; PRs that carry them will be asked to rewrite their commits. You are responsible for every line you submit and must understand it well enough to explain and maintain it.
- **Keep the design.** Dark only, sharp corners, hairline borders, one accent colour. No new themes, blur effects or rounded corners without an agreed issue.
- **No new dependencies** unless an issue has agreed on it. A few lines of code beat a new package.
- **Never break the data file.** `data.json` must keep loading. Any change to its shape needs a migration and a test.
- **One change per PR.** A bug fix and an unrelated refactor are two PRs.
- **Be kind.** Critique code, not people. Harassment of any kind gets you removed from the project.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
