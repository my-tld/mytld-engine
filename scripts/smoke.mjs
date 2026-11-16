// Live check against real registries: node scripts/smoke.mjs [name]
import { createEngine, TOP_TLDS } from "../dist/index.js";

const name = process.argv[2] ?? `zz-smoke-${Date.now().toString(36)}`;
const engine = createEngine();
const t0 = Date.now();
for await (const r of engine.stream(TOP_TLDS.map((t) => `${name}.${t}`))) {
  console.log(`${String(Date.now() - t0).padStart(5)}ms  ${r.domain.padEnd(32)} ${r.status}${r.verified ? "" : " (unverified)"}  via ${r.source}`);
}
