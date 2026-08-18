#!/usr/bin/env tsx

import { createCanvas } from "canvas";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const canvas = createCanvas(200, 200);
const ctx = canvas.getContext("2d");

ctx.fillStyle = "white";
ctx.fillRect(0, 0, 200, 200);

ctx.fillStyle = "red";
ctx.beginPath();
ctx.arc(100, 100, 50, 0, Math.PI * 2);
ctx.fill();

const buffer = canvas.toBuffer("image/png");
const outputPath = join(__dirname, "..", "test", "data", "red-circle.png");

import { mkdirSync } from "fs";
mkdirSync(join(__dirname, "..", "test", "data"), { recursive: true });

writeFileSync(outputPath, buffer);
console.log(`Generated test image at: ${outputPath}`);