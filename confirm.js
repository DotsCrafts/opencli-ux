import { cli, Strategy } from '@jackwener/opencli/registry';
import { runUx } from './_shared.js';
cli({
  site: 'ux', name: 'confirm', access: 'read', strategy: Strategy.PUBLIC, browser: false,
  description: 'Render a block/approval confirmation, return the user choice',
  args: [
    { name: 'spec', positional: true, required: true, help: 'Spec file path, or inline JSON' },
    { name: 'timeout', type: 'int', default: 300, help: 'Max seconds to wait for the user' },
    { name: 'no-open', type: 'boolean', default: false, help: 'Do not open a browser (debug)' },
  ],
  columns: ['action', 'choice'],
  func: async (k) => [await runUx('confirm', k)],
});
