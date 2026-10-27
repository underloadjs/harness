// Server configuration.
//
// The server can run with no configuration at all: the scripted demo needs no
// provider. Live presets read these defaults, and the UI can override the base URL
// and model per session. The API key is never sent to a client.

import type { RunnerSettings } from '../harnesses/types';
import type { HarnessIndex } from './protocol';

export type ServerConfiguration = {
    settings: RunnerSettings;
    defaults: HarnessIndex['defaults'];
};

const DEFAULT_BASE_URL = 'http://localhost:5500/providers/private/v1';
const DEFAULT_MODEL = 'merge/ds4-flash';

export const loadConfiguration = (): ServerConfiguration => {
    const baseURL = process.env.HARNESS_BASE_URL?.trim() || DEFAULT_BASE_URL;
    const apiKey = process.env.HARNESS_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
    const model = process.env.HARNESS_MODEL?.trim() || DEFAULT_MODEL;

    return {
        settings: { baseURL, apiKey, model },
        defaults: {
            baseURL,
            model,
            hasApiKey: apiKey.trim().length > 0
        }
    };
};

// Merge a client's per-session settings over the server defaults.
//
// `apiKey: ''` means "use the server key": the UI leaves the field blank rather
// than shipping a secret, and an empty key is never useful on its own. `baseURL:
// ''` is kept as empty, which is how a live preset reports that it needs one.
export const mergeSettings = (
    defaults: RunnerSettings,
    input: Partial<RunnerSettings> | undefined
): RunnerSettings => {
    const baseURL = input?.baseURL !== undefined ? input.baseURL.trim() : defaults.baseURL;
    const model = input?.model?.trim() || defaults.model;
    const apiKey = input?.apiKey?.trim() ? input.apiKey : defaults.apiKey;

    return { baseURL, model, apiKey };
};
