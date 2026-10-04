/**
 * Run the reader runtime regression suites (tests/runtime) in headless Chrome.
 *
 *   bun run test:runtime            # from apps/web
 *   CHROME_PATH=/path/to/chrome bun run test:runtime
 *
 * Starts the web dev server on a free port, opens tests/runtime/index.html in a fresh
 * headless Chrome profile through the DevTools protocol, waits for the harness to publish
 * `window.__runtimeRegressions`, prints every result and exits non-zero on any failure.
 *
 * Chrome (Blink) is the scriptable parity run. The shipping macOS/iOS engine is WebKit, so
 * layout-sensitive changes still need the foreground Tauri run described in harness.ts.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { RuntimeReport } from "../tests/runtime/harness";
import { launchHeadlessChrome, type HeadlessChrome } from "./headless-chrome";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = Number(process.env.RUNTIME_REGRESSION_TIMEOUT_MS ?? 600_000);

async function main(): Promise<number> {
  const build = Bun.spawnSync([process.execPath, "scripts/build-foliate.ts"], {
    cwd: web,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (build.exitCode !== 0) return build.exitCode ?? 1;

  const server = await createServer({
    root: web,
    configFile: resolve(web, "vite.config.ts"),
    logLevel: "warn",
    server: { host: "127.0.0.1", port: 5190, strictPort: false, hmr: false },
  });
  let chrome: HeadlessChrome | undefined;
  try {
    await server.listen();
    const origin = server.resolvedUrls?.local[0];
    if (!origin) throw new Error("The dev server did not report a local URL");
    chrome = await launchHeadlessChrome();
    const devtools = chrome.devtools;
    const { sessionId } = await chrome.newPage();
    await devtools.send("Page.navigate", { url: new URL("tests/runtime/index.html", origin).href }, sessionId);

    const deadline = Date.now() + TIMEOUT_MS;
    let report: RuntimeReport | undefined;
    while (Date.now() < deadline) {
      const { result } = await devtools.send<{ result: { value?: string } }>(
        "Runtime.evaluate",
        {
          expression: "JSON.stringify(window.__runtimeRegressions ?? null)",
          returnByValue: true,
        },
        sessionId,
      );
      report = result.value ? ((JSON.parse(result.value) as RuntimeReport | null) ?? undefined) : undefined;
      if (report?.done) break;
      await Bun.sleep(500);
    }
    if (!report?.done) throw new Error(`Runtime regressions did not finish within ${TIMEOUT_MS} ms`);
    for (const result of report.results) {
      console.log(`${result.passed ? "pass" : "FAIL"}  [${result.suite}] ${result.name}`);
      if (!result.passed && result.details) console.log(`      ${result.details.replaceAll("\n", "\n      ")}`);
    }
    const failed = report.results.filter((result) => !result.passed).length;
    if (report.error) console.error(`Harness failed: ${report.error}`);
    console.log(`\n${report.results.length - failed} pass, ${failed} fail`);
    return failed === 0 && !report.error && report.results.length > 0 ? 0 : 1;
  } finally {
    await chrome?.close();
    const closing = server.close();
    // Bun can retain HTTP keep-alive connections after Chrome exits.
    // Release them so Vite's server.close callback can finish.
    if (server.httpServer && "closeAllConnections" in server.httpServer) {
      server.httpServer.closeAllConnections();
    }
    await closing;
  }
}

process.exit(await main());
