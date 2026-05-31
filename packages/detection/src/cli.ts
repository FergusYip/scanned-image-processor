#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createDetectionResult } from "./detect.js";

type CliArgs = {
  input?: string;
  output?: string;
  minCropAreaPercent: number;
};

function usage() {
  return [
    "Usage: scan-detect <input-image> <output-json> [--min-area-percent N]",
    "",
    "Writes detected crop quadrilaterals as JSON.",
  ].join("\n");
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { minCropAreaPercent: 4 };
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--") continue;
    if (arg === "--min-area-percent") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--min-area-percent requires a value.");
      args.minCropAreaPercent = Number(value);
      index += 1;
      continue;
    }
    positional.push(arg);
  }

  [args.input, args.output] = positional;
  if (!args.input || !args.output || positional.length > 2) throw new Error(usage());
  if (!Number.isFinite(args.minCropAreaPercent) || args.minCropAreaPercent <= 0) {
    throw new Error("--min-area-percent must be a positive number.");
  }
  return args;
}

async function main(argv: string[]) {
  const args = parseArgs(argv);
  const input = args.input;
  const output = args.output;
  if (!input || !output) throw new Error(usage());
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const result = createDetectionResult(
    path.basename(input),
    {
      data,
      width: info.width,
      height: info.height,
    },
    { minCropAreaPercent: args.minCropAreaPercent },
  );

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`${result.quads.length} detection${result.quads.length === 1 ? "" : "s"} -> ${output}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
