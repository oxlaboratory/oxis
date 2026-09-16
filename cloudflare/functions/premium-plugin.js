/**
 * GET /premium-plugin?plugin=<name>&email=<email>
 *
 * Unlike free plugins (served as plain static files under /plugins/,
 * same as any other asset on this Pages site — see market.ts's
 * fetchPluginSource), premium plugin source is NOT a static file.
 * A static Pages site can't keep a file secret — anyone can fetch any
 * path. Premium source instead lives in a separate KV namespace
 * (`OXIS_PREMIUM_SOURCE`) that's only ever read from here, after
 * checking the requester's license is active.
 *
 * This is what the desktop app's market.ts subscribeInstall() calls
 * once /verify-license confirms an active subscription. The response
 * still travels over plain HTTPS (not additionally encrypted in
 * transit — TLS already covers that); local-disk encryption happens
 * client-side afterward, see pluginEncryption.ts.
 *
 * Publishing into OXIS_PREMIUM_SOURCE isn't wired to a developer UI
 * yet (see README § Third-Party Developer Marketplace — the
 * publishing dashboard is still [planned]); for now it's seeded via
 * `wrangler kv:key put --binding=OXIS_PREMIUM_SOURCE "<plugin>" --path=plugin.lua`.
 */

import { getLicense, isActive } from "./lib/licenses.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const plugin = url.searchParams.get("plugin");
  const email = url.searchParams.get("email");
  if (!plugin || !email) return json({ error: "usage: /premium-plugin?plugin=<name>&email=<email>" }, 400);

  if (!env.OXIS_PREMIUM_SOURCE) {
    return json({ error: "OXIS_PREMIUM_SOURCE KV namespace isn't bound on this deployment" }, 503);
  }

  let record;
  try {
    record = await getLicense(env, plugin, email);
  } catch (e) {
    return json({ error: e.message || "license lookup failed" }, 503);
  }
  if (!isActive(record)) {
    return json({ error: "no active subscription for this plugin/email — subscribe via 'market subscribe " + plugin }, 402);
  }

  const source = await env.OXIS_PREMIUM_SOURCE.get(plugin);
  if (!source) return json({ error: `no premium source published for ${plugin} yet` }, 404);

  return json({ plugin, source });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
