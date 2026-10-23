import { FieldsGetResult, QuerySpec } from '../odoo/types';

export interface ValidationIssue {
	field?: string;
	message: string;
	severity: 'error' | 'warning';
}

/**
 * Validates a spec against the model's field metadata.
 *
 * Catches the mistakes an LLM is most likely to make — hallucinated field
 * names, wrong operators, bad limits — before a round-trip to the server.
 */
export function validateSpec(spec: QuerySpec, fields: FieldsGetResult): ValidationIssue[] {
	const issues: ValidationIssue[] = [];

	if (!spec.model?.trim()) {
		issues.push({ message: 'No model specified.', severity: 'error' });
		return issues;
	}

	for (const field of spec.fields ?? []) {
		if (!fields[field]) {
			issues.push({
				field,
				message: `Field "${field}" does not exist on ${spec.model}.`,
				severity: 'error',
			});
		}
	}

	for (const issue of validateDomain(spec.domain ?? [], fields)) {
		issues.push(issue);
	}

	if (spec.order) {
		for (const clause of spec.order.split(',')) {
			const name = clause.trim().split(/\s+/)[0];
			if (name && !fields[name]) {
				issues.push({
					field: name,
					message: `Cannot sort on unknown field "${name}".`,
					severity: 'error',
				});
			}
		}
	}

	if (spec.limit !== undefined && spec.limit < 0) {
		issues.push({ message: 'Limit cannot be negative.', severity: 'error' });
	}

	return issues;
}

/** Validates a domain's field names and operators. */
export function validateDomain(domain: unknown[], fields: FieldsGetResult): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	walkDomain(domain, fields, issues);
	return issues;
}

function walkDomain(
	node: unknown,
	fields: FieldsGetResult,
	issues: ValidationIssue[],
): void {
	if (!Array.isArray(node)) {
		return;
	}

	// A leaf is `[field, operator, value]`.
	if (typeof node[0] === 'string' && typeof node[1] === 'string') {
		const [field, operator] = node as [string, string];
		if (!fields[field]) {
			issues.push({
				field,
				message: `Domain references unknown field "${field}".`,
				severity: 'error',
			});
		}
		if (!isKnownOperator(operator)) {
			issues.push({
				field,
				message: `Unknown domain operator "${operator}".`,
				severity: 'error',
			});
		}
		return;
	}

	// Otherwise it is a nested list or a `'&' | '|' | '!'` prefix.
	for (const child of node) {
		if (typeof child === 'string') {
			if (!['&', '|', '!'].includes(child)) {
				issues.push({
					message: `Unknown domain prefix "${child}".`,
					severity: 'error',
				});
			}
			continue;
		}
		walkDomain(child, fields, issues);
	}
}

const KNOWN_OPERATORS = new Set([
	'=',
	'!=',
	'>',
	'>=',
	'<',
	'<=',
	'=?',
	'in',
	'not in',
	'like',
	'not like',
	'ilike',
	'not ilike',
	'=like',
	'=ilike',
	'child_of',
	'parent_of',
	'any',
	'not any',
]);

export function isKnownOperator(operator: string): boolean {
	return KNOWN_OPERATORS.has(operator);
}

/** Formats issues into a single message suitable for an LLM or a notification. */
export function formatIssues(issues: ValidationIssue[]): string {
	return issues.map((issue) => `- ${issue.message}`).join('\n');
}
