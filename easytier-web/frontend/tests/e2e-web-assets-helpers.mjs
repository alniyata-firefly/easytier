import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function assetPath(value) {
    assert.equal(typeof value, 'string', 'asset path must be a string');
    assert.ok(value && !value.includes('\\') && !value.startsWith('/')
        && value.split('/').every(part => part && part !== '.' && part !== '..'), 'asset path must be relative and canonical');
    return value;
}

function reactReport(bytes) {
    const report = JSON.parse(bytes.toString('utf8'));
    assert.equal(report.schema_version, 1, 'unsupported React bundle audit schema');
    assert.equal(report.framework, 'react', 'embedded frontend must be React');
    assert.ok(Number.isInteger(report.react_module_count) && report.react_module_count > 0, 'React runtime must occur in the actual bundle graph');
    assert.equal(report.legacy_vue_module_count, 0, 'legacy Vue runtime must not occur in the actual bundle graph');
    return report;
}

async function treeFiles(root, prefix = '') {
    const files = [];
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        assert.ok(!entry.isSymbolicLink(), 'expected frontend must not contain symlinks');
        if (entry.isDirectory()) files.push(...await treeFiles(root, relative));
        else {
            assert.ok(entry.isFile(), 'expected frontend must contain only regular files');
            files.push(relative);
        }
    }
    return files.sort();
}

/** Load an independent, commit-bound expectation before launching the native Web. */
export async function loadFrontendExpectation(directory, commit) {
    assert.match(commit || '', /^[a-f0-9]{40}$/, 'expected source commit must be a complete Git SHA');
    const root = resolve(directory);
    assert.ok((await lstat(root)).isDirectory(), 'expected frontend must be a real directory');
    const manifestBytes = await readFile(join(root, 'source-manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    assert.equal(manifest.source_commit, commit, 'expected frontend source differs from the workflow commit');
    assert.equal(manifest.platform, 'web-static');
    assert.ok(typeof manifest.version === 'string' && manifest.version, 'expected frontend version is missing');
    assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, 'expected frontend manifest must list all files');
    const files = new Map();
    for (const record of manifest.files) {
        const relative = assetPath(record.path);
        assert.ok(!files.has(relative), 'frontend manifest must not contain duplicate files');
        assert.ok(relative !== 'source-manifest.json' && relative !== 'api_meta.js'
            && !relative.startsWith('config-generator/'), 'legacy/deployment-specific content must not be published');
        assert.ok(Number.isSafeInteger(record.bytes) && record.bytes >= 0, 'invalid frontend file size');
        assert.match(record.sha256 || '', /^[a-f0-9]{64}$/, 'invalid frontend file hash');
        files.set(relative, record);
    }
    assert.deepEqual(await treeFiles(root), [...files.keys(), 'source-manifest.json'].sort(), 'frontend manifest must describe exactly the expected file tree');
    for (const [relative, record] of files) {
        const bytes = await readFile(join(root, relative));
        assert.equal(bytes.length, record.bytes, `expected frontend file size mismatch: ${relative}`);
        assert.equal(digest(bytes), record.sha256, `expected frontend file hash mismatch: ${relative}`);
    }
    assert.ok(files.has('index.html'), 'expected frontend entry is missing');
    assert.ok(files.has('react-bundle-audit.json'), 'expected frontend bundle graph audit is missing');
    assert.ok(files.has('fonts/font-notices.html'), 'font license page must be distributed');
    reactReport(await readFile(join(root, 'react-bundle-audit.json')));
    return { manifest, manifestBytes, files };
}

/** Verify responses from the real embedded HTTP server, not its build directory. */
export async function verifyEmbeddedFrontend(base, expectation) {
    const origin = new URL(base);
    assert.ok(origin.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(origin.hostname)
        && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash,
    'asset verification may contact only a loopback HTTP origin');
    async function get(path) {
        const response = await fetch(new URL(path, origin), {
            redirect: 'manual', cache: 'no-store', headers: { 'Accept-Encoding': 'identity' },
            signal: AbortSignal.timeout(10000),
        });
        assert.equal(response.status, 200, `embedded asset HTTP status: ${path}`);
        return { response, bytes: Buffer.from(await response.arrayBuffer()) };
    }
    const servedManifest = await get('/source-manifest.json');
    assert.ok(servedManifest.bytes.equals(expectation.manifestBytes), 'native Web embeds a different source manifest');
    const verified = [];
    let index, report;
    for (const [relative, record] of expectation.files) {
        const path = '/' + relative.split('/').map(encodeURIComponent).join('/');
        const { response, bytes } = await get(path);
        assert.equal(bytes.length, record.bytes, `embedded asset byte count mismatch: ${relative}`);
        assert.equal(digest(bytes), record.sha256, `embedded asset hash mismatch: ${relative}`);
        if (relative === 'index.html') {
            index = bytes;
            assert.match(response.headers.get('cache-control') || '', /no-cache|no-store/, 'embedded entry must not remain stale in browser cache');
        }
        if (relative === 'react-bundle-audit.json') report = reactReport(bytes);
        verified.push({ path: relative, bytes: bytes.length, sha256: record.sha256 });
    }
    const root = await get('/');
    assert.ok(root.bytes.equals(index), 'native Web root must serve the verified React entry');
    assert.match(root.response.headers.get('cache-control') || '', /no-cache|no-store/, 'root entry must not remain stale in browser cache');
    const metadata = await get('/api_meta.js');
    const match = metadata.bytes.toString('utf8').trim().match(/^window\.apiMeta\s*=\s*(\{[\s\S]*\})\s*;?$/);
    assert.ok(match, 'native Web must serve dynamic API metadata');
    assert.deepEqual(JSON.parse(match[1]), { api_host: '' }, 'default embedded console must use same-origin API requests');
    return {
        source_commit: expectation.manifest.source_commit, version: expectation.manifest.version,
        source_manifest_sha256: digest(servedManifest.bytes), files_verified: verified.length,
        bytes_verified: verified.reduce((sum, item) => sum + item.bytes, 0),
        react_bundle: report, root_matches_entry: true, same_origin_api: true,
        files: verified,
    };
}
