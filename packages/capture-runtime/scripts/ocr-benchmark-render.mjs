// Local deterministic raster fixture generation, not a browser product journey.
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  templates: { type: 'string' }, 'font-root': { type: 'string' }, output: { type: 'string' },
} });
for (const key of ['templates', 'font-root', 'output']) {
  if (!values[key]) throw new Error(`--${key} is required`);
}
const sha = (data) => createHash('sha256').update(data).digest('hex');
const templateBytes = await readFile(values.templates);
const templates = JSON.parse(templateBytes.toString('utf8'));
const output = resolve(values.output);
await mkdir(output); // A run is never merged into an earlier render.
const fonts = {};
for (const font of ['YuGothR.ttc', 'msgothic.ttc']) {
  const path = resolve(values['font-root'], font);
  fonts[font] = { path, sha256: sha(await readFile(path)) };
}
const css = templates.css.replaceAll(
  'file://__FONT_ROOT__/', `${pathToFileURL(resolve(values['font-root'])).href}/`,
);
const browser = await chromium.launch({ headless: true, args: ['--allow-file-access-from-files'] });
const records = [];
try {
  for (const template of templates.pages) {
    if (!/^[a-z0-9_-]+$/i.test(template.id)) throw new Error('Invalid synthetic page ID');
    const pageDir = join(output, template.id);
    await mkdir(pageDir);
    const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${css}</style></head><body><div class="page" style="font-family:'${template.fontFamily}';font-size:${template.fontSize}px">${template.blocksHtml}</div></body></html>`;
    const htmlPath = join(pageDir, 'page.html');
    await writeFile(htmlPath, html, { flag: 'wx' });
    const images = {};
    let glyphs;
    for (const [name, scale] of [['clean', 1.5], ['hi', 3.125]]) {
      const context = await browser.newContext({ viewport: templates.viewport, deviceScaleFactor: scale });
      try {
        const page = await context.newPage();
        await page.goto(pathToFileURL(htmlPath).href);
        await page.evaluate(async () => {
          await Promise.all(['JPSerif', 'JPSans'].map((f) => document.fonts.load(`14px "${f}"`)));
          await document.fonts.ready;
          if ([...document.fonts].some((font) => font.status !== 'loaded')) {
            throw new Error('Pinned local font failed to load');
          }
        });
        if (name === 'clean') {
          // Text and geometry come from the synthetic source, never an OCR candidate.
          glyphs = await page.evaluate(() => {
            const result = [];
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            const rubies = [...document.querySelectorAll('ruby')];
            const paragraphs = [...document.querySelectorAll('p')];
            let node;
            while ((node = walker.nextNode())) {
              const element = node.parentElement;
              const block = element.closest('[data-block]');
              if (!block) continue;
              let offset = 0;
              for (const character of node.textContent) {
                const start = offset;
                offset += character.length;
                if (/\s/u.test(character)) continue;
                const range = document.createRange();
                range.setStart(node, start); range.setEnd(node, offset);
                const rect = range.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0 || rect.left < 0 || rect.top < 0 ||
                    rect.right > innerWidth + 0.5 || rect.bottom > innerHeight + 0.5) {
                  throw new Error(`Synthetic glyph is clipped or absent: ${block.dataset.block}`);
                }
                result.push({ character, block: block.dataset.block, kind: block.dataset.kind,
                  ruby: !!element.closest('rt'), signature: !!element.closest('.sig'),
                  rubyId: rubies.indexOf(element.closest('ruby')),
                  paragraph: paragraphs.indexOf(element.closest('p')),
                  polygon: [[rect.left, rect.top], [rect.right, rect.top],
                    [rect.right, rect.bottom], [rect.left, rect.bottom]],
                });
              }
            }
            return result;
          });
          glyphs = glyphs.map((g) => ({ ...g, polygon: g.polygon.map(([x, y]) => [x * scale, y * scale]) }));
        }
        const path = join(pageDir, `${name}.png`);
        const png = await page.screenshot({ path, fullPage: false });
        images[name] = { path, sha256: sha(png), scale };
      } finally {
        await context.close();
      }
    }
    const glyphPath = join(pageDir, 'synthetic-glyphs.json');
    const glyphBytes = Buffer.from(JSON.stringify({
      schemaVersion: 1, status: 'generated-awaiting-visual-review', glyphs,
      sourceHtmlSha256: sha(Buffer.from(html)),
    }, null, 2) + '\n');
    await writeFile(glyphPath, glyphBytes, { flag: 'wx' });
    records.push({ id: template.id, images, glyphCount: glyphs.length,
      html: { path: htmlPath, sha256: sha(Buffer.from(html)) },
      glyphs: { path: glyphPath, sha256: sha(glyphBytes) },
    });
    process.stdout.write(JSON.stringify({ id: template.id, glyphCount: glyphs.length }) + '\n');
  }
} finally {
  await browser.close();
}
await writeFile(join(output, 'render-manifest.json'), JSON.stringify({
  schemaVersion: 1, templateSha256: sha(templateBytes),
  rendererSha256: sha(await readFile(fileURLToPath(import.meta.url))),
  chromiumVersion: browser.version(), fonts, localFontSubstitution: templates.localFontSubstitution,
  records, phasePass: false,
}, null, 2) + '\n', { flag: 'wx' });
