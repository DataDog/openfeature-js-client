# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a monorepo for Datadog's OpenFeature JavaScript clients, providing browser and React Native clients for Datadog's OpenFeature implementation. The project is currently in alpha development.

## Monorepo Structure

This is a Lerna-managed monorepo with two packages:
- `packages/browser/` - Browser-specific OpenFeature bindings (@datadog/openfeature-browser)
- `packages/core/` - Runtime-agnostic flag evaluation logic (@datadog/flagging-core)

The browser package depends on the core package for shared functionality.

## Development Commands

**Building:**
- `yarn build` - Build all packages (runs `lerna run build --stream`)
- `yarn build:bundle` - Build bundled versions for all packages
- `lerna run build` - Build specific package from its directory

**Testing:**
- `yarn test` - Run tests for all packages (runs `lerna run test --stream`)
- `yarn test:unit:watch` - Run tests in watch mode with parallel execution
- Run `jest` directly in individual package directories for single package testing

**Linting and Formatting:**
- `yarn lint` - Check code with Biome linter (`biome check . --diagnostic-level=error`)
- `yarn lint:fix` - Fix lint issues with Biome (`biome check --write .`)
- `yarn typecheck` - Run TypeScript type checking for all packages
- `yarn format` - Check formatting with Prettier
- `yarn format:fix` - Fix formatting with Prettier

**Package Management:**
- Uses Yarn 4.9.2 as package manager
- `yarn clean` - Clean build artifacts from all packages
- Individual packages support `yarn build`, `yarn test`, `yarn typecheck`

## Code Style and Standards

- Uses Biome for linting with recommended rules enabled
- Formatting: 2-space indents, 80 character line width, single quotes, semicolons as needed
- TypeScript with strict configuration
- Each package has separate tsconfig files for CJS, ESM, and test builds
- Browser package builds both CommonJS and ESM distributions plus webpack bundle

## Architecture Notes

**Core Package (@datadog/flagging-core):**
- Runtime-agnostic flag evaluation logic
- Contains configuration wire format handling
- Exports both CJS and ESM builds

**Browser Package (@datadog/openfeature-browser):**
- Wraps core package for browser environments
- Integrates with Datadog Browser SDK (@datadog/browser-core)
- Implements OpenFeature provider interface
- Includes RUM integration and exposure logging
- Builds CJS, ESM, and webpack bundle formats

**Key Integration Points:**
- Uses OpenFeature Web SDK as peer dependency
- Integrates with Datadog's RUM (Real User Monitoring) system
- Supports exposure event tracking and batching
- Configuration fetching via HTTP transport layer

## Testing Strategy

- Jest for unit testing with jsdom environment for browser tests
- Test files use `.spec.ts` extension
- Coverage reports generated in `packages/*/coverage/`
- Precomputed test data in `packages/browser/test/data/`