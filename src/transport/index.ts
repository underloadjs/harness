// @underload/harness transport — the wire protocol layer.
//
// A transport turns a HarnessStreamRequest into an async iterable of stream
// events. It never executes tools and never mutates agent history.
//
// `listModels` is the sibling lookup: providers advertise what they serve at
// GET {baseURL}/models, and the harness UI/server need those ids before a
// session can pick a model. It shares the URL normalization, bearer auth, and
// error-message rules with the chat transport (see ./models.ts).
export { openAICompatible } from './openai';
export { listModels, ModelListError } from './models';
export type { ModelListConfiguration, ModelListErrorKind } from './models';
