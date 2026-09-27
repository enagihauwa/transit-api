import { ApiError } from './errors.js';

function issuesToMessages(issues) {
  return issues.map((issue) => {
    if (issue.code === 'unrecognized_keys') {
      const keys = issue.keys.map((k) => `"${k}"`).join(', ');
      return `unexpected ${issue.keys.length > 1 ? 'fields' : 'field'} ${keys}`;
    }
    const field = issue.path.length ? issue.path.join('.') : 'body';
    const message = issue.message === 'Required' ? 'is required' : issue.message;
    return `${field}: ${message}`.replace(/:\s*$/, '');
  });
}

function describe(schema, data) {
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, messages: issuesToMessages(result.error.issues) };
}

export function validateBody(schema, data) {
  const { ok, messages, data: parsed } = describe(schema, data);
  if (ok) return parsed;
  const fields = messages.map((m) => m.split(':')[0].trim());
  throw new ApiError(422, 'VALIDATION_ERROR', `Validation failed: ${messages.join('; ')}`, { fields });
}
