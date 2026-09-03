/**
 * Vapi control-plane client — the Node mirror of clients/vapi.py.
 *
 * The private key authenticates api.vapi.ai. The public key is browser-only
 * and is rejected here by design.
 */

import { require_ } from './env.mjs';

const BASE_URL = 'https://api.vapi.ai';

export class VapiError extends Error {}

async function request(method, path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${require_('VAPI_PRIVATE_KEY')}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new VapiError(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 600)}`);
  }
  return text ? JSON.parse(text) : null;
}

export const vapi = {
  assistants: () => request('GET', '/assistant'),
  assistant: (id) => request('GET', `/assistant/${id}`),
  createAssistant: (payload) => request('POST', '/assistant', payload),
  updateAssistant: (id, payload) => request('PATCH', `/assistant/${id}`, payload),
  phoneNumbers: () => request('GET', '/phone-number'),
  calls: () => request('GET', '/call'),
};
