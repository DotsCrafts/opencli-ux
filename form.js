import { cli, Strategy } from '@jackwener/opencli/registry';
import { runUx } from './_shared.js';
cli({
  site: 'ux', name: 'form', access: 'read', strategy: Strategy.PUBLIC, browser: false,
  description: 'Render a form, block until the user submits, return captured values',
  args: [
    { name: 'spec', positional: true, required: true, help: 'Spec file path, or inline JSON' },
    { name: 'timeout', type: 'int', default: 300, help: 'Max seconds to wait for the user' },
    { name: 'no-open', type: 'boolean', default: false, help: 'Do not open a browser (debug)' },
  ],
  columns: ['submitted', 'action', 'values'],
  func: async (k) => [await runUx('form', k)],
});
