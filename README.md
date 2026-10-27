# @underload/harness

Standard underload harness. Ease to build and execute.

> **Status:** scaffold. The public API is added to `src/index.ts` as the
> harness is implemented.

## Install

```bash
yarn add @underload/harness
```

## Usage

```ts
import * as harness from '@underload/harness';
```

## Development

```bash
yarn install
yarn test       # vitest run
yarn typecheck  # tsc --noEmit
yarn build      # vite build + declaration emit -> dist/
```

## npm Publishing

The package is publishable to npm as `@underload/harness`.

```bash
yarn build      # dist/underload-harness.mjs + dist/index.d.ts
yarn publish    # prepublishOnly runs: typecheck -> test -> build
```

- **Public API = `src/index.ts`.** JS is bundled by Vite into
  `dist/underload-harness.mjs`; declarations are emitted to `dist/index.d.ts`.
- `package.json` points `main` / `module` / `types` / `exports` at `dist/`,
  and `files` ships only `dist/` - tooling configs and tests never reach npm.
- `sideEffects: false` + `exports` make the package tree-shakeable.
- `publishConfig.access` is `public`, so the scoped package publishes
  publicly to the npm registry.

## License

ISC
