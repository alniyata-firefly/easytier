/** Render fresh SVG-derived preview PNGs; no application/native build is run. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = process.argv[2] && resolve(process.argv[2]);
assert.ok(directory, 'Pass the --preview-dir output from generate-brand-icons.py');
const { chromium } = createRequire(join(root, 'easytier-gui/package.json'))('playwright');
const data = async path => `data:image/png;base64,${(await readFile(path)).toString('base64')}`;
const sizes = [16, 24, 32, 64, 128, 256];
const images = await Promise.all(sizes.map(async size => ({ size, uri: await data(join(directory, `${size}x${size}.png`)) })));
const styles = `*{box-sizing:border-box}body{margin:0;width:1140px;padding:28px;background:#f3f5f9;color:#30343b;font:14px Arial,sans-serif}h1{font-size:24px;font-weight:500;margin:0 0 8px}p{color:#626b78;margin:0 0 20px;line-height:1.6}section{padding:20px;margin-bottom:20px;border-radius:16px;background:white;border:1px solid #e1e5eb}section.dark{background:#172131;color:#eaf0f9;border-color:#334155}h2{font-size:16px;margin:0 0 16px;font-weight:500}.grid{display:grid;grid-template-columns:100px 100px 100px 160px 220px 300px;justify-content:center;gap:4px}.sample{height:306px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px}.sample span{font-size:12px;color:#778191}.dark .sample span{color:#b4c1d4}img{display:block;object-fit:contain;flex:none}.platforms{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}.platform{height:340px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;text-align:center}.mask{width:216px;height:216px;background:white;position:relative;display:flex;align-items:center;justify-content:center}.circle{border-radius:50%}.squircle{border-radius:25%}.safe{position:absolute;width:132px;height:132px;left:42px;top:42px;border:1px dashed #a6b3c6;border-radius:50%;pointer-events:none}.platform small{color:#626b78;line-height:1.5}`;
const samples = images.map(({size,uri}) => `<div class="sample"><img src="${uri}" width="${size}" height="${size}" alt="${size} pixels"><span>${size} × ${size} px · 1:1</span></div>`).join('');
const contact = `<!doctype html><meta charset="UTF-8"><style>${styles}</style><h1>EasyTier · Symmetric network mark</h1><p>Single canonical SVG · blue #006eff · circular nodes · centre-aligned links · actual pixel sizes</p><section><h2>Light background</h2><div class="grid">${samples}</div></section><section class="dark"><h2>Dark background</h2><div class="grid">${samples}</div></section>`;
const icons = join(root, 'easytier-gui/src-tauri/icons');
const foreground = await data(join(icons, 'android/mipmap-xxxhdpi/ic_launcher_foreground.png'));
const native = await data(join(icons, 'icon.png'));
const ios = await data(join(icons, 'ios/AppIcon-60x60@3x.png'));
const windows = await data(join(icons, '32x32.png'));
const platformSheet = `<!doctype html><meta charset="UTF-8"><style>${styles}</style><h1>EasyTier · Native icon safe areas</h1><p>Generated asset preview, not a device screenshot. Android dashed circle is the 66 / 108 dp safe area; highest-density foreground reduced to 216 px.</p><section><div class="platforms"><div class="platform"><img src="${windows}" width="32" height="32" alt="Windows 32"><small>Windows · 32 px<br>ICO embeds the same mark</small></div><div class="platform"><img src="${native}" width="216" height="216" alt="macOS mark"><small>macOS · 216 px preview<br>ICNS exports from the same SVG</small></div><div class="platform"><div class="mask circle"><img src="${foreground}" width="216" height="216" alt="Android circular mask"><span class="safe"></span></div><small>Android · circular mask<br>66 / 108 dp safe circle</small></div><div class="platform"><div class="mask squircle"><img src="${foreground}" width="216" height="216" alt="Android squircle mask"><span class="safe"></span></div><small>Android · rounded square<br>identical foreground geometry</small></div></div></section><section class="dark"><div class="platforms"><div class="platform"><img src="${windows}" width="32" height="32" alt="Windows dark"><small>Windows · dark desktop</small></div><div class="platform"><img src="${native}" width="216" height="216" alt="macOS dark"><small>macOS · dark desktop</small></div><div class="platform"><div class="mask circle"><img src="${foreground}" width="216" height="216" alt="Android circular mask on dark"></div><small>Android · opaque adaptive background</small></div><div class="platform"><img src="${ios}" width="180" height="180" style="border-radius:22%" alt="iOS icon"><small>Apple touch / iOS · 180 px<br>opaque white background</small></div></div></section>`;
await mkdir(directory, { recursive:true });
const browser = await chromium.launch({ headless:true, executablePath:process.env.ET_CHROMIUM_PATH || undefined, args:['--no-sandbox'] });
try {
    const page = await browser.newPage({viewport:{width:1140,height:1000},deviceScaleFactor:1});
    for(const [name,html] of [['contactsheet',contact],['platforms',platformSheet]]) {
        const path = join(directory, `${name}.html`);
        await writeFile(path, html);
        await page.goto(pathToFileURL(path).href);
        await page.evaluate(async () => { await Promise.all([...document.images].map(image => image.decode())); });
        await page.screenshot({path:join(directory, `${name}.png`),fullPage:true});
    }
} finally { await browser.close(); }
console.log(JSON.stringify({status:'PASS',preview_directory:directory,files:['contactsheet.png','platforms.png'],native_build_executed:false}));
