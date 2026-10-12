import {assert, rejects} from "./test_helpers.ts";
import {DriveTokenCache} from "./token_cache.ts";

Deno.test("parallel retrievals share a refresh and expired tokens refresh before use", async () => {
  let now = 1000, calls = 0;
  const cache = new DriveTokenCache(() => now);
  const load = async () => { calls++; await Promise.resolve(); return {access_token: `token-${calls}`, expires_in: 3600}; };
  const first = await Promise.all(Array.from({length: 12}, () => cache.get("clinic", load)));
  assert(first.every(value => value.value === "token-1"));
  assert(Number(calls) === 1);
  now += 3540000;
  assert((await cache.get("clinic", load)).value === "token-2");
  assert(Number(calls) === 2);
});
Deno.test("cache invalidation does not erase a newer token and failed refreshes can retry", async () => {
  const cache = new DriveTokenCache(); let calls = 0;
  const load = async () => ({access_token: `token-${++calls}`, expires_in: 3600});
  await cache.get("clinic", load);
  cache.invalidate("clinic", "token-1");
  assert((await cache.get("clinic", load)).value === "token-2");
  cache.invalidate("clinic", "token-1");
  assert((await cache.get("clinic", load)).value === "token-2");
  await rejects(() => cache.get("different", () => Promise.reject(new Error("offline"))));
  assert((await cache.get("different", load)).value === "token-3");
});
Deno.test("missing expiry is not shared and distinct connection keys remain isolated", async () => {
  const cache = new DriveTokenCache(); let calls = 0;
  const load = async () => ({access_token: `token-${++calls}`});
  await cache.get("clinic", load); await cache.get("clinic", load);
  assert(Number(calls) === 2);
  const a = await cache.get("account-a", async () => ({access_token: "account-a", expires_in: 3600}));
  const b = await cache.get("account-b", async () => ({access_token: "account-b", expires_in: 3600}));
  assert(a.value === "account-a" && b.value === "account-b");
});
