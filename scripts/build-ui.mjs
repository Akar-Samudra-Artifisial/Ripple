// Builds the Custom UI views into static/<view>/build (index.html + main.js + main.css).
import { build } from 'esbuild';
import { mkdir, rm, writeFile } from 'node:fs/promises';

const VIEWS = { byline: 'Ripple', settings: 'Ripple settings', approval: 'Ripple update' };
const watch = process.argv.includes('--watch');

const html = (title) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="./main.css" />
  </head>
  <body>
    <div id="root"></div>
    <script src="./main.js"></script>
  </body>
</html>
`;

for (const [view, title] of Object.entries(VIEWS)) {
  const outdir = `static/${view}/build`;
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  await writeFile(`${outdir}/index.html`, html(title));
  await build({
    entryPoints: { main: `ui/src/${view}.tsx` },
    outdir,
    bundle: true,
    minify: !watch,
    sourcemap: watch ? 'inline' : false,
    format: 'iife',
    target: 'es2020',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
    logLevel: 'warning',
  });
  console.log(`built ${outdir}`);
}
