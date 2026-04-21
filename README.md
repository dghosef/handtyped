# Handtyped

Source for [handtyped.app](https://handtyped.app)

ironically most of the code in this repo was written by AI

## Build instructions

- Build the Rust binary:
  - `cargo build --bin handtyped_native`
- For the signed app bundle used in normal development:
  - `npm run dev:native`

## Notes

- No Windows support yet, but would welcome PRs.
- `npm` is only used as a thin wrapper around the Rust build/sign/launch workflow.
