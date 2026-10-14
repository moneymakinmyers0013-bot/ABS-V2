export const supportedAgentTasks = [
  { id: 'csv_cleanup', title: 'CSV cleanup', priceCents: 100, currency: 'USD', description: 'Trim column names and normalize whitespace in string values.', inputSchema: { type: 'object', required: ['rows'], properties: { rows: { type: 'array', items: { type: 'object' }, minItems: 1, maxItems: 10000 } } } },
  { id: 'data_normalization', title: 'Data normalization', priceCents: 100, currency: 'USD', description: 'Normalize keys and whitespace in structured row data.', inputSchema: { type: 'object', required: ['rows'], properties: { rows: { type: 'array', items: { type: 'object' }, minItems: 1, maxItems: 10000 } } } },
  { id: 'duplicate_removal', title: 'Duplicate removal', priceCents: 100, currency: 'USD', description: 'Remove exact duplicate structured rows.', inputSchema: { type: 'object', required: ['rows'], properties: { rows: { type: 'array', items: { type: 'object' }, minItems: 1, maxItems: 10000 } } } },
  { id: 'data_transformation', title: 'Data transformation', priceCents: 100, currency: 'USD', description: 'Map input keys into a new output schema.', inputSchema: { type: 'object', required: ['rows', 'mapping'], properties: { rows: { type: 'array', items: { type: 'object' } }, mapping: { type: 'object', additionalProperties: { type: 'string' } } } } },
  { id: 'categorization', title: 'Data categorization', priceCents: 100, currency: 'USD', description: 'Assign categories using explicit substring rules.', inputSchema: { type: 'object', required: ['rows', 'categoryField', 'categories'], properties: { rows: { type: 'array', items: { type: 'object' } }, categoryField: { type: 'string' }, categories: { type: 'array', items: { type: 'string' } } } } }
] as const;

export const agentCard = {
  schemaVersion: '1.0',
  name: 'ABS v2 Agentic Workforce',
  description: 'Provider-evidence-gated digital task execution with deterministic quotes, independent output validation, artifact integrity checks, and reconciliation.',
  protocol: 'abs-agent-http-v1',
  catalogPath: '/agent/v1/catalog',
  createJobPath: '/agent/v1/jobs',
  payment: { methods: ['paypal'], currency: 'USD', note: 'PayPal approval may require buyer interaction. No x402/crypto payment is advertised as enabled unless a verified adapter is installed.' },
  taskPolicy: { fixedPrice: true, priceCents: 100, executeOnlyAfterProviderConfirmedPayment: true, independentVerification: true },
  tasks: supportedAgentTasks
};
