// @underload/harness transport — the wire protocol layer.
//
// A transport turns a HarnessStreamRequest into an async iterable of stream
// events. It never executes tools and never mutates agent history.
export { openAICompatible } from './openai';
