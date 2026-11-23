// The names the API reads from its environment (RUNTIME_ENV_NAMES in src/config.ts), as
// '@tinnox/api/test-support/runtime-env'. The e2e stack (tests/e2e/support/stack.ts) builds the
// API's environment from them, and the stackless layout checks of the quality job load that
// file too: so this entry pulls in the configuration only, never the harness of ./support.ts
// (buildApp, sharp, the root .env), whose break would fail a check about layout (CHK-9).
export { RUNTIME_ENV_NAMES } from '../src/config.ts';
