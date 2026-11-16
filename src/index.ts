/**
 * @mytld/engine: fast, honest domain availability checks for Node.js.
 *
 *   DNS (c-ares, hundreds in parallel) → RDAP → WHOIS
 *   "available" is only reported after a registry confirmed it.
 *
 * This is the Node-only entry. For browser-safe helpers import
 * "@mytld/engine/domain" or "@mytld/engine/tlds".
 */

export { createEngine } from "./engine/create-engine.js";
export type { CheckOptions, Engine, EngineOptions } from "./engine/options.js";

export { memoryStore, redisStore } from "./cache/store.js";
export type { CacheStore, RedisLike } from "./cache/store.js";

export { parseWhois } from "./lookup/whois-parser.js";

export * from "./core/domain.js";
export * from "./core/tlds.js";
