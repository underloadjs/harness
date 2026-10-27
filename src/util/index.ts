// @underload/harness util — leaf helpers shared by every other folder.
//
// A leaf on purpose: nothing here imports core, transport, or harness, so any
// layer can depend on it without creating a cycle.
export { HarnessError, toErrorInfo } from './errors';
