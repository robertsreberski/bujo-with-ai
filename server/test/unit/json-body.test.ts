import { describe, expect, it } from 'vitest';
import { classifyJsonBodyClientError } from '../../src/api/json-body.js';

function bodyError(type: string, status: number): Error {
  return Object.assign(new Error('raw parser detail must not escape'), { type, status });
}

describe('classifyJsonBodyClientError', () => {
  it('recognizes documented client failures without reclassifying internal parser faults', () => {
    expect(classifyJsonBodyClientError(bodyError('entity.too.large', 413))).toEqual({
      kind: 'payload_too_large',
      status: 413,
    });
    expect(classifyJsonBodyClientError(bodyError('charset.unsupported', 415))).toEqual({
      kind: 'unsupported_encoding',
      status: 415,
    });
    expect(classifyJsonBodyClientError(bodyError('stream.not.readable', 500))).toBeNull();
    expect(classifyJsonBodyClientError(bodyError('entity.too.large', 500))).toBeNull();
  });
});
