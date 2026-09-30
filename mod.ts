import * as esbuild from "npm:esbuild";
import { denoPlugin } from "jsr:@deno/esbuild-plugin";

import { serveDir } from "https://deno.land/std/http/file_server.ts";
import { copy } from "https://deno.land/std/fs/mod.ts";
import { ensureDir } from "https://deno.land/std/fs/ensure_dir.ts";


export type BuildOpts = {
  // output path
  distPath?: string;
  outputPath?: string;

  // path to index.html
  htmlPath?: string;
  // path to directory which contains public files
  publicPath?: string;

  denoConfig?: string;
  buildOptions?: esbuild.BuildOptions
}


const RELOAD_SCRIPT = `<script>
  const reload = new EventSource("/__reload");
  reload.addEventListener("reload", () => { location.reload(); });
</script>`;

const DEFAULT_HTML = `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Demo</title>
  </head>
  <body>
    <noscript>You need to enable JavaScript to run this app. Alternatively see our client libraries or API documentation.</noscript>
    <script type="module" src="main.js"></script>
    ${RELOAD_SCRIPT}
  </body>
</html>
`;
const DEFAULT_HTML_PROD = `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My Page</title>
  </head>
  <body>
    <noscript>You need to enable JavaScript to run this app. Alternatively see our client libraries or API documentation.</noscript>
    <script type="module" src="main.js"></script>
  </body>
</html>
`;


export async function serve(opts: BuildOpts = {}) {
  // apply defaults
  opts.distPath = opts.distPath ?? "dist";
  opts.outputPath = opts.outputPath ?? "main.js";
  opts.denoConfig = opts.denoConfig ?? "./deno.json";
  opts.buildOptions = opts.buildOptions ?? {
    entryPoints: [`src/main.ts`],
  };

  // copy static files (if configured)
  await ensureDir(opts.distPath);
  if (opts.publicPath) {
    await copy(opts.publicPath, opts.distPath, { overwrite: true });
  }

  if (opts.htmlPath) {
    // read index.html content & inject reload event listener:
    let htmlContent = await Deno.readTextFile(opts.htmlPath);
    htmlContent = htmlContent.replace(
      "</head>",
      `${RELOAD_SCRIPT}\n\n</head>`,
    );
    await Deno.writeTextFile(`${opts.distPath}/index.html`, htmlContent);
    htmlContent = "";
  } else {
    // minimum html file needed for reloading
    await Deno.writeTextFile(`${opts.distPath}/index.html`, DEFAULT_HTML);
  }


  // browsers connected to the live-reload endpoint
  const clients = new Set<ReadableStreamDefaultController>();
  const encoder = new TextEncoder();

  // esbuild plugin that tells browsers to reload after a successful build
  const reloadPlugin: esbuild.Plugin = {
    name: "reload",
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length > 0)
          return;

        console.log("Build complete, sending reload");

        const message = encoder.encode(
          "event: reload\ndata: reload\n\n",
        );

        for (const client of clients) {
          try {
            client.enqueue(message);
          } catch {
            clients.delete(client);
          }
        }
      });
    },
  };

  const ctx = await esbuild.context({
    // usual esbuild defaults
    outfile: opts.distPath + "/" + opts.outputPath,
    bundle: true,
    platform: "browser",
    format: "esm",
    sourcemap: true,
    minify: true,
    treeShaking: true,

    plugins: [
      denoPlugin({
        configPath: opts.denoConfig,
      }),
      reloadPlugin,
    ],

    // user overrides:
    ...opts.buildOptions
  });

  await ctx.watch();


  Deno.serve((req) => {
    const url = new URL(req.url);

    if (url.pathname === "/__reload") {
      let controller: ReadableStreamDefaultController;

      const stream = new ReadableStream({
        start(c) {
          controller = c;
          clients.add(c);

          // Initial SSE message
          c.enqueue(new TextEncoder().encode(": connected\n\n"));
        },

        cancel() {
          clients.delete(controller);
        },
      });

      req.signal.addEventListener("abort", () => {
        clients.delete(controller);
        try {
          controller.close();
        } catch {
          // already closed
        }
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    return serveDir(req, {
      fsRoot: opts.distPath,
      showDirListing: false,
    });
  });

  console.log(`serving: ${opts.buildOptions.entryPoints}`);
}


export async function build(opts: BuildOpts = {}) {
  // apply defaults
  opts.distPath = opts.distPath ?? "dist";
  opts.outputPath = opts.outputPath ?? "main.js";
  opts.denoConfig = opts.denoConfig ?? "./deno.json";
  opts.buildOptions = opts.buildOptions ?? {
    entryPoints: ["src/main.ts"],
  };

  // Create output directory
  await ensureDir(opts.distPath);
  // Copy static files
  if (opts.publicPath) {
    await copy(opts.publicPath, opts.distPath, { overwrite: true });
  }
  if (opts.htmlPath) {
    await copy(opts.htmlPath, `${opts.distPath}/index.html`, { overwrite: true });
  } else {
    // Minimal production HTML
    await Deno.writeTextFile(
      `${opts.distPath}/index.html`,
      DEFAULT_HTML_PROD.replace(RELOAD_SCRIPT, ""),
    );
  }

  // Production build
  const result = await esbuild.build({
    // Production defaults
    outfile: `${opts.distPath}/${opts.outputPath}`,
    bundle: true,
    platform: "browser",
    format: "esm",
    sourcemap: false,
    minify: true,
    treeShaking: true,

    plugins: [
      denoPlugin({
        configPath: opts.denoConfig,
      }),
    ],

    // User overrides
    ...opts.buildOptions,
  });

  if (result.errors.length > 0) {
    throw new Error("Production build failed");
  }

  console.log(`Built: ${opts.distPath}/${opts.outputPath}`);

  return result;
}