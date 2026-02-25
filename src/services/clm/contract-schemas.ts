/**
 * Predefined Extraction Schemas for Contract Intelligence
 *
 * Used by ocr_contract_extract to parse common contract elements.
 * These are structured extraction schemas compatible with the existing
 * ocr_extract_structured tool's page_schema format.
 *
 * @module clm/contract-schemas
 */

// =============================================================================
// TYPES
// =============================================================================

export interface ContractClause {
  clause_name: string;
  preferred_text: string;
  severity: 'critical' | 'major' | 'minor';
  alternatives: string[];
}

export interface SchemaField {
  name: string;
  type: string;
  description: string;
}

export interface ContractSchema {
  name: string;
  description: string;
  fields: SchemaField[];
}

// =============================================================================
// SCHEMA DEFINITIONS
// =============================================================================

export const CONTRACT_METADATA_SCHEMA: ContractSchema = {
  name: 'contract_metadata',
  description: 'Extract core contract metadata',
  fields: [
    { name: 'parties', type: 'list', description: 'All parties to the contract' },
    { name: 'effective_date', type: 'date', description: 'Contract effective/start date' },
    { name: 'expiration_date', type: 'date', description: 'Contract expiration/end date' },
    { name: 'governing_law', type: 'string', description: 'Governing law/jurisdiction' },
    {
      name: 'contract_type',
      type: 'string',
      description: 'Type of contract (NDA, MSA, SOW, etc.)',
    },
  ],
};

export const FINANCIAL_TERMS_SCHEMA: ContractSchema = {
  name: 'financial_terms',
  description: 'Extract financial terms',
  fields: [
    { name: 'total_value', type: 'currency', description: 'Total contract value' },
    { name: 'payment_schedule', type: 'string', description: 'Payment schedule/terms' },
    { name: 'penalties', type: 'list', description: 'Late payment or breach penalties' },
    { name: 'interest_rate', type: 'string', description: 'Interest rate if applicable' },
  ],
};

export const OBLIGATIONS_SCHEMA: ContractSchema = {
  name: 'obligations',
  description: 'Extract obligations and deadlines',
  fields: [
    { name: 'deadlines', type: 'list', description: 'All dates/deadlines with descriptions' },
    { name: 'deliverables', type: 'list', description: 'Required deliverables' },
    { name: 'responsibilities', type: 'list', description: 'Party responsibilities' },
  ],
};

export const RENEWAL_TERMINATION_SCHEMA: ContractSchema = {
  name: 'renewal_termination',
  description: 'Extract renewal and termination terms',
  fields: [
    { name: 'auto_renewal', type: 'boolean', description: 'Whether contract auto-renews' },
    {
      name: 'renewal_notice_period',
      type: 'string',
      description: 'Notice period for renewal/non-renewal',
    },
    { name: 'termination_triggers', type: 'list', description: 'Events that trigger termination' },
    {
      name: 'termination_notice_period',
      type: 'string',
      description: 'Notice required for termination',
    },
  ],
};

export const COMPLIANCE_SCHEMA: ContractSchema = {
  name: 'compliance_clauses',
  description: 'Extract compliance-related clauses',
  fields: [
    { name: 'indemnification', type: 'string', description: 'Indemnification clause summary' },
    { name: 'liability_limit', type: 'string', description: 'Limitation of liability' },
    { name: 'force_majeure', type: 'boolean', description: 'Whether force majeure clause exists' },
    { name: 'confidentiality', type: 'string', description: 'Confidentiality terms' },
    { name: 'data_protection', type: 'string', description: 'Data protection/privacy terms' },
  ],
};

export const ALL_CONTRACT_SCHEMAS: ContractSchema[] = [
  CONTRACT_METADATA_SCHEMA,
  FINANCIAL_TERMS_SCHEMA,
  OBLIGATIONS_SCHEMA,
  RENEWAL_TERMINATION_SCHEMA,
  COMPLIANCE_SCHEMA,
];

/**
 * Get schemas by name. If names is empty or undefined, returns all schemas.
 */
export function getSchemasByName(names?: string[]): ContractSchema[] {
  if (!names || names.length === 0) {
    return ALL_CONTRACT_SCHEMAS;
  }

  const schemaMap = new Map<string, ContractSchema>();
  for (const schema of ALL_CONTRACT_SCHEMAS) {
    schemaMap.set(schema.name, schema);
  }

  const result: ContractSchema[] = [];
  for (const name of names) {
    const schema = schemaMap.get(name);
    if (!schema) {
      throw new Error(
        `Unknown schema: "${name}". Available: ${ALL_CONTRACT_SCHEMAS.map((s) => s.name).join(', ')}`
      );
    }
    result.push(schema);
  }
  return result;
}
