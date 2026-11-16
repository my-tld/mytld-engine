import assert from "node:assert/strict";
import { test } from "node:test";
import { createEngine, isValidDomain, memoryStore, parseQuery, parseWhois, redisStore, TOP_TLDS, ALL_TLDS } from "../dist/index.js";
import { parseQuery as browserParse } from "../dist/core/domain.js";

test("parseQuery normalises input", () => {
  assert.deepEqual(parseQuery("  Hello.DEV "), { name: "hello", tld: "dev" });
  assert.deepEqual(parseQuery("https://www.acme.io/path?x"), { name: "acme", tld: "io" });
  assert.deepEqual(parseQuery("müller"), { name: "xn--mller-kva", tld: null });
  assert.equal(parseQuery("-bad"), null);
  assert.equal(parseQuery("ab--cd"), null);
  assert.equal(browserParse, parseQuery);
});

test("isValidDomain", () => {
  assert.ok(isValidDomain("hello.com"));
  assert.ok(!isValidDomain("a.b.com"));
  assert.ok(!isValidDomain("hello"));
  assert.ok(!isValidDomain("-x.com"));
});

test("TLD lists", () => {
  assert.equal(TOP_TLDS[0], "com");
  assert.equal(new Set(ALL_TLDS).size, ALL_TLDS.length);
});

test("parseWhois never guesses 'taken'", () => {
  assert.equal(parseWhois("No match for domain"), "available");
  assert.equal(parseWhois("Status: free"), "available");
  assert.equal(parseWhois("Domain Name: EXAMPLE.COM\nRegistrar: X"), "taken");
  assert.equal(parseWhois("Number of allowed queries exceeded."), "unknown");
  assert.equal(parseWhois("some unparseable banner"), "unknown");
  assert.equal(parseWhois(""), "unknown");
});

test("memoryStore TTL + pttl", async () => {
  const s = memoryStore();
  await s.set("a", "1", 10);
  assert.equal(await s.get("a"), "1");
  assert.deepEqual(await s.mget(["a", "b"]), ["1", null]);
  assert.ok((await s.pttl("a")) > 9000);
  assert.ok((await s.pttl("missing")) <= 0);
});

test("redisStore treats a disconnected client as a miss", async () => {
  const fake = { status: "connecting", get: async () => "x", mget: async () => ["x"], set: async () => {}, pttl: async () => 1 };
  const s = redisStore(fake);
  assert.equal(await s.get("k"), null);
  assert.deepEqual(await s.mget(["k"]), [null]);
});

test("checkMany rejects invalid input", async () => {
  const e = createEngine();
  await assert.rejects(e.checkMany(["not a domain"], () => {}), TypeError);
});

test("cached answers are served without network", async () => {
  const store = memoryStore();
  await store.set("dom:v2:cached-example.com", JSON.stringify({ status: "taken", verified: true }), 60);
  const e = createEngine({ store, dnsServers: ["192.0.2.1"] }); // unroutable: proves no lookup happens
  const r = await e.check("cached-example.com");
  assert.deepEqual(r, { domain: "cached-example.com", status: "taken", verified: true, source: "cache" });
});

test("store failures never break a lookup", async () => {
  const broken = { get: async () => { throw new Error("x"); }, mget: async () => { throw new Error("x"); }, set: async () => { throw new Error("x"); }, pttl: async () => { throw new Error("x"); } };
  const e = createEngine({ store: broken, dnsServers: ["192.0.2.1"], dnsTimeoutMs: 200, rdapTimeoutMs: 200, whoisTimeoutMs: 200, fetch: async () => { throw new Error("offline"); } });
  const r = await e.check("never-registered-example.invalidtld");
  assert.equal(r.status, "unknown");
});
