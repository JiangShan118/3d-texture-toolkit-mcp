import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'texture-mcp-smoke-'));
const invalidFile = path.join(directory, 'invalid.glb');
await writeFile(invalidFile, 'not a GLB');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve('dist/index.js')],
  cwd: process.cwd(),
});
const client = new Client({ name: 'texture-toolkit-smoke', version: '0.1.0' });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    ['extract_pbr_maps']
  );
  const result = await client.callTool({
    name: 'extract_pbr_maps',
    arguments: { glb_path: invalidFile },
  });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /valid-sized GLB/);
  assert.equal((await client.listTools()).tools.length, 1);
  process.stdout.write(
    'MCP stdio initialize, tools/list, and tools/call passed.\n'
  );
} finally {
  await client.close();
  await rm(directory, { recursive: true, force: true });
}
