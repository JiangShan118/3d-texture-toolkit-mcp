# 3D Texture Toolkit MCP

A local MCP server that extracts embedded PBR texture images from GLB files.
It exposes one tool: `extract_pbr_maps`.

## Requirements

- Node.js 20 or newer
- An MCP client that supports local stdio servers

## Install and run

After this package is published to npm, install it in an MCP client using
`npx`:

```sh
npx -y 3d-texture-toolkit-mcp
```

The server reads the GLB path supplied by the MCP client and writes extracted
images to disk. Base color and normal images keep their original PNG, JPEG, or
WebP bytes. The glTF metallic-roughness image is split into grayscale PNG files:
roughness comes from the green channel and metallic comes from the blue channel.
The corresponding glTF material factors are applied to those two maps.

## Client configuration

Example configuration for an MCP client that accepts a `mcpServers` object:

```json
{
  "mcpServers": {
    "3d-texture-toolkit": {
      "command": "npx",
      "args": ["-y", "3d-texture-toolkit-mcp"]
    }
  }
}
```

For local development before an npm release, build the package and point the
client at `node` with the absolute path to `dist/index.js` as its argument.

## Tool inputs

- `glb_path` (required): path to a local GLB 2.0 file.
- `output_dir` (optional): output folder. By default, a folder named
  `<glb-name>-textures` is created beside the GLB.
- `overwrite` (optional, defaults to `false`): replace files with matching
  output names. Existing files are skipped by default.

Output names include the material number, a sanitized material name, and the map
type. The tool reports written files, skipped maps, and warnings.

## Privacy

The server processes files on your computer. It makes no network requests and
does not upload model or texture data. The GLB and output directory must be
accessible to the machine running the MCP server.

## Limitations

- Supports GLB 2.0 with embedded images in buffer views or supported PNG, JPEG,
  and WebP data URIs.
- External image URLs and external buffer files are not read.
- Other image formats, including KTX2 and Basis Universal, are not decoded.
- Texture transforms, alternate UV sets, occlusion maps, emissive maps, and
  extensions that alter material interpretation are not applied.
- Packed metallic-roughness images are converted to grayscale PNGs. Base color
  and normal images are copied without recompression.
- Files larger than 512 MiB and decoded images above 100 million pixels are
  rejected by safety limits.

## Publication status

This repository contains a prepared package and Registry metadata. It has not
been published to npm or submitted to the official MCP Registry. The package
uses the MIT License; npm publication and Registry submission have not yet
happened.
