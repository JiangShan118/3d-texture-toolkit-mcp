#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { extractPbrMaps, ExtractionError } from './extract.js';

const server = new McpServer({
  name: '3d-texture-toolkit',
  version: '0.1.0',
});

server.registerTool(
  'extract_pbr_maps',
  {
    title: 'Extract PBR maps from a GLB',
    description:
      'Extract embedded base color and normal images, and split the glTF metallic-roughness image into roughness and metallic PNG files. Reads and writes local files only.',
    inputSchema: {
      glb_path: z.string().min(1).describe('Path to a local .glb file.'),
      output_dir: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Directory for extracted images. Defaults to <glb-name>-textures beside the GLB.'
        ),
      overwrite: z
        .boolean()
        .default(false)
        .describe(
          'Replace files with matching output names. Defaults to false.'
        ),
    },
  },
  async ({ glb_path, output_dir, overwrite }) => {
    try {
      const result = await extractPbrMaps({
        glbPath: glb_path,
        ...(output_dir ? { outputDir: output_dir } : {}),
        overwrite,
      });
      const lines = [
        `Output directory: ${result.outputDir}`,
        `Written files (${result.writtenFiles.length}):`,
        ...(result.writtenFiles.length
          ? result.writtenFiles.map((file) => `- ${file}`)
          : ['- none']),
        `Skipped maps (${result.skippedMaps.length}):`,
        ...(result.skippedMaps.length
          ? result.skippedMaps.map((item) => `- ${item}`)
          : ['- none']),
        `Warnings (${result.warnings.length}):`,
        ...(result.warnings.length
          ? result.warnings.map((item) => `- ${item}`)
          : ['- none']),
      ];
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        structuredContent: { ...result },
      };
    } catch (error) {
      const message =
        error instanceof ExtractionError
          ? error.message
          : `Could not extract PBR maps: ${error instanceof Error ? error.message : 'unknown error'}`;
      return {
        content: [{ type: 'text' as const, text: message }],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(
    `3D Texture Toolkit MCP failed to start: ${error instanceof Error ? error.message : 'unknown error'}`
  );
  process.exitCode = 1;
});
