/**
 * export-failures.js
 *
 * Queries the n8n REST API to read this workflow's static data and
 * writes the failure records to submission/src/failures.log (JSON-lines format).
 *
 * Usage:
 *   node submission/src/export-failures.js [workflowId]
 *
 * Prerequisites:
 *   - n8n is running on http://localhost:5678
 *   - N8N_API_KEY env var set, or n8n has no auth (default for local installs)
 *
 * Find your workflowId in the n8n UI URL: .../workflow/[id]
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const N8N_BASE = process.env.N8N_BASE_URL || 'http://localhost:5678';
const API_KEY  = process.env.N8N_API_KEY  || '';

const workflowId = process.argv[2];
if (!workflowId) {
  console.error('Usage: node submission/src/export-failures.js <workflowId>');
  console.error('Find your workflowId in the n8n UI URL: .../workflow/[id]');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  ...(API_KEY ? { 'X-N8N-API-KEY': API_KEY } : {})
};

const res = await fetch(`${N8N_BASE}/api/v1/workflows/${workflowId}`, { headers });
if (!res.ok) {
  console.error(`Failed to fetch workflow: HTTP ${res.status}`);
  process.exit(1);
}

const workflow = await res.json();
const staticData = workflow.staticData || {};
const failures = staticData.failures || [];

if (failures.length === 0) {
  console.log('No failures recorded.');
  process.exit(0);
}

const __dir = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dir, 'failures.log');
const lines = failures.map(f => JSON.stringify(f)).join('\n') + '\n';
writeFileSync(outPath, lines, 'utf-8');

console.log(`Wrote ${failures.length} failure record(s) to ${outPath}`);
failures.forEach(f => console.log(' -', JSON.stringify(f)));
