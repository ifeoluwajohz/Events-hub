#!/usr/bin/env node
// Marks ended PUBLISHED events as COMPLETED. Schedule it (e.g. hourly cron):
//   npm run jobs:complete-events
require("dotenv").config();
const { completeEndedEvents } = require("../src/services/events");
const { disconnect } = require("../src/db");

completeEndedEvents({ actor: null })
  .then(({ completed }) => console.log(`Completed ${completed} event(s).`))
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(disconnect);
