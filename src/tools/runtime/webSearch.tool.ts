// webSearch — independently compiled source entry for the opt-in search tool.
//
// A search credential belongs to ONE harness, so the harness creates the provider
// closure and exposes it as a live runtime operation. This entry is the registered
// implementation contract: startup compiles THIS file through the shared kernel and
// supplies the configured provider/schema as metadata overrides. No credential or
// provider-specific value appears in this source.
//
// A replacement registered under `webSearch` is an ordinary source revision and
// does not inherit the configured provider closure.
export const metadata = {
    name: 'webSearch',
    description:
        'Search the web through the provider configured for this harness. The configured provider/schema is supplied at registration; this generic revision is replaceable source.',
    tags: ['web', 'search', 'internet', 'news', 'research'],
    visibility: 'searchable' as const,
    parameters: {
        type: 'object',
        properties: {
            query: { type: 'string' }
        },
        required: ['query'],
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
    activation: 'websearch',
    order: 240,
    sessionBound: true,
    alwaysDeclared: false,
    listed: false
} as const;

export const execute = (context: any) => {
    const harness = context?.harness;

    if (harness === undefined) {
        throw new Error('webSearch requires the live harness reference.');
    }

    return harness.runtime.webSearch(context);
};
