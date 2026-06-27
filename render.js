import { cli, Strategy } from '@jackwener/opencli/registry';
import { runUx } from './_shared.js';
cli({
  site: 'ux', name: 'render', access: 'read', strategy: Strategy.PUBLIC, browser: false,
  description: 'Render a UI spec to the user in an isolated browser tab (non-blocking)',
  args: [
    { name: 'spec', positional: true, required: true, help: 'Spec file path, or inline JSON' },
    { name: 'no-open', type: 'boolean', default: false, help: 'Do not open a browser (debug)' },
  ],
  columns: ['rendered', 'url', 'session'],
  func: async (k) => [await runUx('render', k)],
});
