// fetch — independently compiled source entry for the opt-in page fetch tool.
//
// The harness owns provider selection and any Exa credential; this entry is the
// registered implementation contract compiled through the shared kernel. Static
// metadata below is a valid fallback; the harness overrides description, tags, and
// schema with the dynamic per-harness provider surface at registration.
export const metadata = {
    name: 'fetch',
    description:
        'Fetch a page through the provider configured for this harness. The configured provider/schema is supplied at registration; this generic revision is replaceable source.',
    tags: ['web', 'fetch', 'internet', 'read', 'url', 'research'],
    // R9-R11: core, so a harness that HAS this capability declares it on every
    // request (no toolRequest round needed to start researching). Registration is
    // still config-gated by the activation below - a host without a provider key
    // (search) or without `webfetch` (fetch) never registers the row, so nothing is
    // promised that the session cannot run.
    visibility: 'core' as const,
    parameters: {
        type: 'object',
        properties: {
            url: { type: 'string' }
        },
        required: ['url'],
        additionalProperties: true
    }
};
// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract, so
// they never reach the schema a model sees. `../../core/tool-discovery.ts` READS
// this literal through the TypeScript AST (it never executes the module), so the
// activation/order/flags here are what actually drive registration.
export const registration = {
    group: 'runtime',
    activation: 'webfetch',
    // T2/R2: SYNC, same policy as the search entry - the fetched bytes are the input to
    // the next turn. See tools/runtime/search.tool.ts for the full reasoning.
    mode: 'sync',
    order: 250,
    sessionBound: true,
    alwaysDeclared: true,
    listed: false
} as const;

export const execute = (context: any) => {
    const harness = context?.harness;

    if (harness === undefined) {
        throw new Error('fetch requires the live harness reference.');
    }

    return harness.runtime.fetch(context);
};
