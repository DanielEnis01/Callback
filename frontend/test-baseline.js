const fs = require("fs");
const path = require("path");

const dbPath = path.join(
  process.env.HOME,
  "Library/Application Support/callback-frontend/Local Storage/leveldb"
);
console.log("Local Storage path:", dbPath);
