export function installProxyFromEnv(): void {
  const e = process.env;
  const proxy = e.HTTPS_PROXY || e.https_proxy || e.HTTP_PROXY || e.http_proxy || e.ALL_PROXY || e.all_proxy;
  if (!proxy) return;
  try {
    // Lazy require: keep undici off the cold path when no proxy is configured.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ProxyAgent, setGlobalDispatcher } = require("undici") as typeof import("undici");
    setGlobalDispatcher(new ProxyAgent({ uri: proxy }));
    // eslint-disable-next-line no-console
    console.log(`  ℹ routing outbound HTTPS through proxy ${redact(proxy)} (NO_PROXY honored by undici)`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `  ⚠ a proxy env var is set but the proxy agent couldn't be installed (${
        err instanceof Error ? err.message : String(err)
      }); outbound requests may fail to reach external services.`
    );
  }
}

/** Hide any user:pass in the proxy URL before logging it. */
function redact(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.username || u.password) {
      u.username = "***";
      u.password = "";
    }
    return u.toString();
  } catch {
    return uri.replace(/\/\/[^@/]*@/, "//***@");
  }
}
