import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';

const build = join(resolve(process.argv[2]), 'build');
const records = [];
for (const entry of readdirSync(build, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith('easytier-gui-')) continue;
  const root = join(build, entry.name, 'out', 'tauri-codegen-assets');
  if (!existsSync(root)) continue;
  for (const asset of readdirSync(root, { withFileTypes: true })) {
    if (!asset.isFile()) continue;
    const file = join(root, asset.name);
    const encoded = readFileSync(file);
    let decoded = encoded;
    let encoding = 'none';
    try {
      decoded = brotliDecompressSync(encoded, { maxOutputLength: 32 * 1024 * 1024 });
      encoding = 'brotli';
    } catch {
      // Some build outputs are already stored without compression.
    }
    const text = decoded.toString('utf8');
    records.push({ file, encoding, decoded_sha256: createHash('sha256').update(decoded).digest('hex'),
      html: text.toLowerCase().includes('<html') ? text : null });
  }
}
process.stdout.write(JSON.stringify(records));
