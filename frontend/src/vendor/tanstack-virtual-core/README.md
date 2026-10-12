# TanStack Virtual Core

- Package: `@tanstack/virtual-core@3.13.12`
- Source: https://github.com/TanStack/virtual
- API: https://tanstack.com/virtual/v3/docs/api/virtualizer
- License: MIT, included in `LICENSE`.
- Distribution: npm ESM files with `process.env.NODE_ENV` replaced by the production constant for direct browser use. Kept locally so the frontend works without a CDN or build step.

Run `node scripts/vendor-virtual-core.mjs` to reproduce these files. The script verifies the pinned npm archive's SHA-512 digest before extracting the listed files.
