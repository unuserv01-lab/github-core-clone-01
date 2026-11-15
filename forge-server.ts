// forge-server.ts — test helper, NOT part of the entry's runtime.
// Starts the forge on an ephemeral port and prints "PORT <n>" to stdout.
// Spawned by test-forge.ts as a separate process so git CLI calls (which block
// the test process's event loop while they run) can still reach the server.
process.env.MAKEFUN_SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? 'forge-test-token';
const { createApp } = await import('./app.ts');
const server = createApp();
server.listen(0, () => {
  console.log(`PORT ${(server.address() as { port: number }).port}`);
});
