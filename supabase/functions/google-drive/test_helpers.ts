export function assert(value: unknown, message = "Assertion failed"): asserts value { if (!value) throw new Error(message); }
export async function rejects(run: () => Promise<unknown>) { let rejected = false; try { await run(); } catch { rejected = true; } assert(rejected, "Expected rejection"); }
