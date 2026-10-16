// Small HTTP fixtures for the native asset verifier. These do not replace the
// release-binary integration test and never compile or start EasyTier.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadFrontendExpectation, verifyEmbeddedFrontend } from './e2e-web-assets-helpers.mjs';

const commit = 'a'.repeat(40);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), 'web-assets-verifier-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const files = new Map(Object.entries({
        'index.html': '<html><script type="module" src="/assets/app.js"></script></html>',
        'assets/app.js': '/* synthetic React fixture */',
        'fonts/font-notices.html': '<html>synthetic font license</html>',
        'react-bundle-audit.json': JSON.stringify({ schema_version: 1, framework: 'react', react_module_count: 2, legacy_vue_module_count: 0 }),
    }).map(([path, bytes]) => [path, Buffer.from(bytes)]));
    for (const [path, bytes] of files) {
        await mkdir(join(directory, path, '..'), { recursive: true });
        await writeFile(join(directory, path), bytes);
    }
    const manifest = { source_commit: commit, version: '2.7.2', platform: 'web-static',
        files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes) })) };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(join(directory, 'source-manifest.json'), manifestBytes);
    const expected = await loadFrontendExpectation(directory, commit);
    const responses = new Map(files);
    responses.set('source-manifest.json', manifestBytes);
    responses.set('api_meta.js', Buffer.from('window.apiMeta = {"api_host":""}'));
    const server = createServer((request, response) => {
        const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname).slice(1) || 'index.html';
        const bytes = responses.get(path);
        response.writeHead(bytes ? 200 : 404, { 'Cache-Control': 'no-cache, no-store' });
        response.end(bytes || 'not found');
    });
    await new Promise((accept, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', accept);
    });
    t.after(() => new Promise(accept => { server.closeAllConnections(); server.close(accept); }));
    return { directory, expected, responses, manifest, base: `http://127.0.0.1:${server.address().port}` };
}

await test('matching responses verify all assets and default same-origin API', async t => {
    const f = await fixture(t);
    const result = await verifyEmbeddedFrontend(f.base, f.expected);
    assert.equal(result.files_verified, 4);
    assert.equal(result.source_commit, commit);
    assert.equal(result.same_origin_api, true);
    assert.equal(result.root_matches_entry, true);
});

await test('reject stale embedded entry even when its source manifest claims the expected commit', async t => {
    const f = await fixture(t);
    f.responses.set('index.html', Buffer.from('<html>old build</html>'));
    await assert.rejects(verifyEmbeddedFrontend(f.base, f.expected), /embedded asset (?:byte count|hash) mismatch: index.html/);
});

await test('reject changed asset bytes even when filename and size are preserved', async t => {
    const f = await fixture(t);
    const asset = Buffer.from(f.responses.get('assets/app.js'));
    asset[0] ^= 1;
    f.responses.set('assets/app.js', asset);
    await assert.rejects(verifyEmbeddedFrontend(f.base, f.expected), /embedded asset hash mismatch: assets\/app.js/);
});

await test('reject an internally consistent old frontend instead of trusting its served manifest', async t => {
    const f = await fixture(t);
    f.responses.set('source-manifest.json', Buffer.from(JSON.stringify({ ...f.manifest, source_commit: 'b'.repeat(40) })));
    await assert.rejects(verifyEmbeddedFrontend(f.base, f.expected), /embeds a different source manifest/);
});

await test('reject missing assets and off-origin API metadata', async t => {
    const f = await fixture(t);
    const original = f.responses.get('fonts/font-notices.html');
    f.responses.delete('fonts/font-notices.html');
    await assert.rejects(verifyEmbeddedFrontend(f.base, f.expected), /embedded asset HTTP status: \/fonts\/font-notices.html/);
    f.responses.set('fonts/font-notices.html', original);
    f.responses.set('api_meta.js', Buffer.from('window.apiMeta = {"api_host":"https://example.invalid"}'));
    await assert.rejects(verifyEmbeddedFrontend(f.base, f.expected), /default embedded console must use same-origin API requests/);
});

await test('reject wrong independent commit and unrecorded or mutated build inputs', async t => {
    const f = await fixture(t);
    await assert.rejects(loadFrontendExpectation(f.directory, 'b'.repeat(40)), /differs from the workflow commit/);
    await writeFile(join(f.directory, 'extra.js'), 'unrecorded');
    await assert.rejects(loadFrontendExpectation(f.directory, commit), /exactly the expected file tree/);
    await rm(join(f.directory, 'extra.js'));
    await writeFile(join(f.directory, 'assets/app.js'), 'mutated');
    await assert.rejects(loadFrontendExpectation(f.directory, commit), /expected frontend file (?:size|hash) mismatch/);
});
