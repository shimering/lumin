// Local integration harness used by tests/google-drive-sync.test.py.
import {fixture} from "./test_fixture.ts";
const f = await fixture();
const server = Deno.serve({hostname: "127.0.0.1", port: Number(Deno.args[0] || 0), onListen: address => console.log(JSON.stringify({port: address.port}))}, async request => {
  const url = new URL(request.url);
  if (url.pathname === "/test/upload") return new Response(JSON.stringify(await f.upload(new TextEncoder().encode("cloud-xray"))));
  return f.handler(request);
});
await server.finished;
