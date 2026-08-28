import { createGameServer } from "./server.js";

const configuredPort = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const testSpawn = process.env.WORLD_TEST_SPAWN === "clustered"
  ? (index: number) => ({ x: 4_000 + index * 90, y: 4_000 })
  : undefined;
const gameServer = createGameServer(undefined, { worldSpawn: testSpawn, worldPositionSecret: process.env.WORLD_POSITION_SECRET });
const port = await gameServer.listen(configuredPort, "0.0.0.0");
console.log(`Blob Soccer authoritative server listening on ${port}`);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await gameServer.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
