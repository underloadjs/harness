// @underload/harness transport — the wire protocol layer.
//
// A transport turns a HarnessStreamRequest into an async iterable of stream
// events. It never executes tools and never mutates agent history.
//
// `listModels` is the sibling lookup: providers advertise what they serve at
// GET {baseURL}/models, and the harness UI/server need those ids before a
// session can pick a model. It shares the URL normalization, bearer auth, and
// error-message rules with the chat transport (see ./models.ts).
export {
    openAICompatible,
    MAX_EXTRA_BODY_BYTES,
    MAX_RESPONSE_SCHEMA_NAME_CHARS,
    // (issue 0004) The one machine name for "the prompt does not fit". The transport
    // raises it for a provider 400/413 size rejection; ../core/agent.ts raises the
    // same code from its pre-request guard and treats it as non-retriable.
    CONTEXT_OVERFLOW_CODE,
    PROVIDER_REQUEST_BODY_CODE
} from './openai';
export { listModels, ModelListError } from './models';
export type { ModelListConfiguration, ModelListErrorKind } from './models';
