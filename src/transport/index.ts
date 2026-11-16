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
// (T6) The two provider failure classes and their bounds. The codes are what
// ../core/agent.ts switches on for its retry policy; the defaults and variable names
// are the operator-facing contract (`.env.example` quotes the same names).
export {
    PROVIDER_CONNECTION_CODE,
    PROVIDER_TIMEOUT_CODE,
    // (T8, AC3) The third provider failure class: a deterministic refusal. Exported so
    // ../core/agent.ts can keep it out of the ladder on the same switch as the others.
    PROVIDER_REJECTED_CODE,
    DEFAULT_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS,
    DEFAULT_PROVIDER_FIRST_TOKEN_TIMEOUT_MS,
    DEFAULT_PROVIDER_STREAM_CHUNK_TIMEOUT_MS,
    PROVIDER_RESPONSE_HEAD_TIMEOUT_ENV,
    PROVIDER_FIRST_TOKEN_TIMEOUT_ENV,
    PROVIDER_STREAM_CHUNK_TIMEOUT_ENV,
    PROVIDER_TIMEOUT_MAX_MS,
    resolveProviderTimeout,
    providerURLOf,
    connectionFailureOf
} from './provider-timeouts';
export type { ProviderConnectionFailure, ProviderTimeoutPhase } from './provider-timeouts';
export { listModels, ModelListError } from './models';
export type { ModelListConfiguration, ModelListErrorKind } from './models';
