require("dotenv").config();
const { loadConfig } = require("./src/config");
const { createApp } = require("./src/app");
const { createClerkIdentity } = require("./src/auth/identity");
const { disconnect } = require("./src/db");

const config = loadConfig();
const app = createApp({ config, identity: createClerkIdentity(config.clerk) });

const server = app.listen(config.port, () => {
  console.log(`API listening on port ${config.port}`);
});

const shutdown = () => server.close(() => disconnect().finally(() => process.exit(0)));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
