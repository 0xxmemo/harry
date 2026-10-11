#!/usr/bin/env bash
# Load the demo CRM into an Atlas cluster: HARRY_URI=mongodb+srv://... ./scripts/seed/seed-atlas.sh
set -euo pipefail
: "${HARRY_URI:?set HARRY_URI to a read-write connection string}"
cd "$(dirname "$0")/../.."
HARRY_DIR="$PWD/demo-crm" mongosh --nodb --quiet --eval '
const db = new Mongo(process.env.HARRY_URI).getDB("harry_demo_crm");
const fs = require("fs");
const iso = /^\d{4}-\d\d-\d\dT/;
for (const name of ["reps", "accounts", "deals", "activities"]) {
  const docs = JSON.parse(fs.readFileSync(process.env.HARRY_DIR + "/" + name + ".json", "utf8"), (k, v) => typeof v === "string" && iso.test(v) ? new Date(v) : v);
  db[name].drop();
  db[name].insertMany(docs);
  print(name + ": " + docs.length);
}'
