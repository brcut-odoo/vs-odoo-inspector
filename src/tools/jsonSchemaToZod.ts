import { z } from 'zod';

/**
 * Converts the subset of JSON Schema used by our tool definitions into Zod.
 *
 * The tool registry declares `inputSchema` as JSON Schema because that is what
 * VS Code's `contributes.languageModelTools` requires. The MCP SDK wants Zod,
 * so we translate rather than maintaining two copies of every schema.
 *
 * Supported: object, string, number, integer, boolean, array, and nested
 * objects. Anything else degrades to `z.unknown()`.
 */
export function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
	if (!schema || typeof schema !== 'object') {
		return z.unknown();
	}
	const node = schema as Record<string, unknown>;

	if (Array.isArray(node.enum)) {
		const values = node.enum.filter((value): value is string => typeof value === 'string');
		if (values.length) {
			return z.enum(values as [string, ...string[]]);
		}
	}

	switch (node.type) {
		case 'string':
			return z.string();
		case 'number':
			return z.number();
		case 'integer':
			return z.number().int();
		case 'boolean':
			return z.boolean();
		case 'array': {
			const items = node.items ? jsonSchemaToZod(node.items) : z.unknown();
			return z.array(items);
		}
		case 'object':
			return z.object(shapeOf(node)).passthrough();
		default:
			return z.unknown();
	}
}

/** Builds a `ZodRawShape` from an object schema's `properties`. */
export function shapeOf(schema: Record<string, unknown>): z.ZodRawShape {
	const properties = schema.properties;
	if (!properties || typeof properties !== 'object') {
		return {};
	}

	const required = new Set(
		Array.isArray(schema.required)
			? schema.required.filter((name): name is string => typeof name === 'string')
			: [],
	);

	const shape: z.ZodRawShape = {};
	for (const [name, propertySchema] of Object.entries(properties as Record<string, unknown>)) {
		const zodType = jsonSchemaToZod(propertySchema);
		shape[name] = required.has(name) ? zodType : zodType.optional();
	}
	return shape;
}
