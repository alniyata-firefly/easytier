import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('vite'))('esbuild');

test('management status stays distinct from runtime and peer state', async context => {
    const temporary = await mkdtemp(join(tmpdir(), 'easytier-management-status-'));
    context.after(() => rm(temporary, { recursive: true, force: true }));
    const output = join(temporary, 'status.cjs');
    await esbuild.build({
        stdin: { resolveDir: frontend, loader: 'tsx', contents: `
            import {createElement} from 'react';
            import {renderToStaticMarkup} from 'react-dom/server';
            import {createInstance} from 'i18next';
            import {I18nextProvider} from 'react-i18next';
            import {ManagementStatus} from './src/components/ManagementStatus';
            export {managementConnectionState} from './src/lib/management-status';
            export async function render(resources, language, props) {
                const i18n=createInstance();
                await i18n.init({lng:language,resources:{[language]:{common:resources}},initImmediate:false});
                return renderToStaticMarkup(createElement(I18nextProvider,{i18n},createElement(ManagementStatus,props)));
            }`,
        },
        outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', loader: { '.svg': 'dataurl' },
    });
    const { managementConnectionState, render } = require(output);
    for (const [online, unavailable, expected] of [
        [true, false, 'online'], [false, false, 'offline'], [undefined, false, 'unknown'],
        [true, true, 'unknown'], [false, true, 'unknown'],
    ]) assert.equal(managementConnectionState(online, unavailable), expected);
    for (const language of ['zh-CN', 'en']) {
        const common = JSON.parse(await readFile(join(frontend, 'public/locales', language, 'common.json'), 'utf8'));
        for (const [props, expected] of [
            [{ online: true }, 'online'], [{ online: false }, 'offline'],
            [{ online: true, unknown: true }, 'unknown'], [{}, 'unknown'],
        ]) {
            const html = await render(common, language, props);
            assert.ok(html.includes(`class="status ${expected}"`));
            assert.ok(html.includes(common.managementStatus[expected]));
            assert.notEqual(common.managementStatus[expected], common.status[expected]);
        }
        assert.equal(common.status.online, language === 'zh-CN' ? '在线' : 'Online');
    }
});
