import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(frontend, '../..');
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('vite'))('esbuild');

test('custom lifetimes retain the distinct join credential and management token API contracts', async context => {
    const temporary = await mkdtemp(join(tmpdir(), 'et-lifetime-'));
    context.after(() => rm(temporary, { recursive: true, force: true }));
    const outfile = join(temporary, 'lifetime.cjs');
    await esbuild.build({ entryPoints: [join(frontend, 'src/lib/lifetime.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const { resolveLifetime, MAX_JOIN_CREDENTIAL_SECONDS: joinMax, MAX_MANAGEMENT_TOKEN_SECONDS: tokenMax } = require(outfile);

    await context.test('limits match both existing backend credential services and the token database', async () => {
        const service = await readFile(join(repository, 'easytier-web/src/central_network/service.rs'), 'utf8');
        const tokens = await readFile(join(repository, 'easytier-web/src/restful/device_access_tokens.rs'), 'utf8');
        const database = await readFile(join(repository, 'easytier-web/src/db/device_access_tokens.rs'), 'utf8');
        assert.match(service, /MAX_CREDENTIAL_TTL_SECONDS:\s*u32\s*=\s*365\s*\*\s*24\s*\*\s*3600/);
        for (const source of [tokens, database]) assert.match(source, /seconds\s*==\s*0\s*\|\|\s*seconds\s*>\s*10\s*\*\s*365\s*\*\s*24\s*\*\s*3600/);
        assert.equal(joinMax, 31536000);
        assert.equal(tokenMax, 315360000);
    });
    await context.test('custom whole days convert to exact integer API seconds', () => {
        for (const [days, seconds] of [['1', 86400], ['2', 172800], ['12', 1036800]]) {
            assert.deepEqual(resolveLifetime('custom', days, joinMax), { valid: true, seconds });
        }
    });
    await context.test('custom join lifetimes include one day and the 365-day backend limit', () => {
        assert.deepEqual(resolveLifetime('custom', '1', joinMax), { valid: true, seconds: 86400 });
        assert.deepEqual(resolveLifetime('custom', '365', joinMax), { valid: true, seconds: joinMax });
        assert.deepEqual(resolveLifetime('custom', '366', joinMax), { valid: false });
    });
    await context.test('management tokens allow their actual ten-year limit and remain separate from network grants', () => {
        assert.deepEqual(resolveLifetime('custom', '366', tokenMax, true), { valid: true, seconds: 366 * 86400 });
        assert.deepEqual(resolveLifetime('custom', '3650', tokenMax, true), { valid: true, seconds: tokenMax });
        assert.deepEqual(resolveLifetime('custom', '3651', tokenMax, true), { valid: false });
    });
    await context.test('only the explicit management token no-expiry choice may omit its expiry', () => {
        assert.deepEqual(resolveLifetime('', '', tokenMax, true), { valid: true });
        assert.deepEqual(resolveLifetime('', '', joinMax), { valid: false });
        assert.deepEqual(resolveLifetime('custom', '', tokenMax, true), { valid: false });
    });
    await context.test('blank, zero, negative, fractional, non-finite, and overflowing custom values are rejected', () => {
        for (const value of ['', ' ', '0', '-1', '1.5', 'NaN', 'Infinity', '1e999', '9007199254740992']) {
            assert.deepEqual(resolveLifetime('custom', value, joinMax), { valid: false }, value);
        }
    });
    await context.test('presets ignore unfinished custom drafts and retain their original lifetimes', () => {
        for (const seconds of [86400, 604800, 2592000]) assert.deepEqual(resolveLifetime(String(seconds), '', joinMax), { valid: true, seconds });
        for (const days of [7, 30, 90, 365]) assert.deepEqual(resolveLifetime(String(days * 86400), 'invalid', tokenMax, true), { valid: true, seconds: days * 86400 });
    });
    await context.test('all new duration labels and errors have matching Chinese and English keys', async () => {
        const dictionaries = await Promise.all(['zh-CN', 'en'].map(async locale => ({
            common: JSON.parse(await readFile(join(frontend, `public/locales/${locale}/common.json`), 'utf8')),
            networks: JSON.parse(await readFile(join(frontend, `public/locales/${locale}/networks.json`), 'utf8')),
        })));
        for (const { common, networks } of dictionaries) {
            for (const key of ['custom', 'days']) assert.equal(typeof common.duration[key], 'string');
            assert.match(common.errors.duration, /\{\{maxDays\}\}/);
            assert.equal(typeof networks.members.invalidTtl, 'string');
            for (const key of ['ttl', 'resetTtl', 'ttlAria', 'invalidTtl']) assert.doesNotMatch(networks.credentials[key], /hours|小时/);
        }
    });
});
