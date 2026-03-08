/**
 * One-shot migration: old cliniaacian-prod DB → new aivota-prod DB.
 *
 * Usage:
 *   npx tsx scripts/migrate-db.ts
 *
 * What it does:
 *   1. Makes old RDS temporarily publicly accessible
 *   2. Dumps all data directly from old RDS
 *   3. Reverts old RDS to private
 *   4. Opens an SSM tunnel to new RDS via the bastion
 *   5. Restores all data to new RDS
 *   6. Closes the tunnel
 *
 * Prerequisites:
 *   - AWS CLI configured (profile "aac")
 *   - SSM Session Manager plugin installed
 *   - New infrastructure already deployed via Terraform
 *
 * Delete this file after migration is verified.
 */
import pg from "pg";
import { execSync, spawn, ChildProcess } from "child_process";

const { Client } = pg;

const REGION = "il-central-1";
const OLD_DB_ID = "cliniaacian-prod-postgres";
const OLD_RDS_HOST = "cliniaacian-prod-postgres.cpea2as2c1xa.il-central-1.rds.amazonaws.com";
const OLD_BUCKET = "cliniaacian-prod-uploads-748560966885";
const NEW_BUCKET = "aivota-prod-uploads-748560966885";
const TUNNEL_PORT = 15432; // non-standard port to avoid conflicts

process.env.AWS_PROFILE = process.env.AWS_PROFILE || "aac";

// ============================================================================
// AWS CLI helpers
// ============================================================================
function aws(cmd: string): string {
  return execSync(`aws ${cmd} --region ${REGION}`, { encoding: "utf-8" }).trim();
}

function getMyPublicIp(): string {
  return execSync("curl -s https://checkip.amazonaws.com", { encoding: "utf-8" }).trim();
}

// ============================================================================
// Phase 1a: Make old RDS publicly reachable
// ============================================================================
type OldRdsState = { sgId: string; myIp: string; routeTableId: string; hadExistingRoute: boolean; igwId: string };

function makeOldRdsPublic(): OldRdsState {
  console.log("=== Making old RDS temporarily publicly accessible ===\n");

  // Get RDS info: security group, VPC, subnets
  const rdsInfo = JSON.parse(aws(
    `rds describe-db-instances --db-instance-identifier ${OLD_DB_ID}` +
    ` --query "DBInstances[0].{SG:VpcSecurityGroups[0].VpcSecurityGroupId,VPC:DBSubnetGroup.VpcId,Subnets:DBSubnetGroup.Subnets[*].SubnetIdentifier}" --output json`
  ));
  const sgId: string = rdsInfo.SG;
  const vpcId: string = rdsInfo.VPC;
  const subnetId: string = rdsInfo.Subnets[0]; // pick first subnet
  console.log(`Security group: ${sgId}`);
  console.log(`Old VPC: ${vpcId}`);
  console.log(`RDS subnet: ${subnetId}`);

  // Find IGW attached to old VPC
  const igwId = aws(
    `ec2 describe-internet-gateways` +
    ` --filters "Name=attachment.vpc-id,Values=${vpcId}"` +
    ` --query "InternetGateways[0].InternetGatewayId" --output text`
  );
  if (!igwId || igwId === "None") {
    throw new Error(`No Internet Gateway found for old VPC ${vpcId}. Cannot make RDS publicly accessible.`);
  }
  console.log(`Internet Gateway: ${igwId}`);

  // Find route table for the RDS subnet
  const routeTableId = aws(
    `ec2 describe-route-tables` +
    ` --filters "Name=association.subnet-id,Values=${subnetId}"` +
    ` --query "RouteTables[0].RouteTableId" --output text`
  );
  if (!routeTableId || routeTableId === "None") {
    throw new Error(`No route table found for subnet ${subnetId}.`);
  }
  console.log(`Route table: ${routeTableId}`);

  // Check if there's already a 0.0.0.0/0 route (likely a blackhole to deleted NAT gateway)
  let hadExistingRoute = false;
  try {
    const existingRoute = aws(
      `ec2 describe-route-tables --route-table-ids ${routeTableId}` +
      ` --query "RouteTables[0].Routes[?DestinationCidrBlock=='0.0.0.0/0'].State" --output text`
    );
    hadExistingRoute = existingRoute.length > 0 && existingRoute !== "None";
  } catch {}

  // Add/replace 0.0.0.0/0 route to point to IGW
  if (hadExistingRoute) {
    console.log("Replacing existing default route with IGW route...");
    aws(`ec2 replace-route --route-table-id ${routeTableId} --destination-cidr-block 0.0.0.0/0 --gateway-id ${igwId}`);
  } else {
    console.log("Adding IGW default route...");
    aws(`ec2 create-route --route-table-id ${routeTableId} --destination-cidr-block 0.0.0.0/0 --gateway-id ${igwId}`);
  }
  console.log("Route added.");

  const myIp = getMyPublicIp();
  console.log(`Your public IP: ${myIp}`);

  // Make RDS publicly accessible
  console.log("Setting RDS to publicly accessible...");
  aws(`rds modify-db-instance --db-instance-identifier ${OLD_DB_ID} --publicly-accessible --apply-immediately`);

  // Add SG rule
  console.log(`Adding security group rule for ${myIp}/32 on port 5432...`);
  try {
    aws(`ec2 authorize-security-group-ingress --group-id ${sgId} --protocol tcp --port 5432 --cidr ${myIp}/32`);
  } catch {
    console.log("  (rule may already exist)");
  }

  console.log("Waiting for RDS modification (2-5 minutes)...");
  aws(`rds wait db-instance-available --db-instance-identifier ${OLD_DB_ID}`);
  console.log("Old RDS is now publicly accessible.\n");

  return { sgId, myIp, routeTableId, hadExistingRoute, igwId };
}

// ============================================================================
// Phase 1c: Revert old RDS to private
// ============================================================================
function revertOldRds(state: OldRdsState) {
  console.log("\n=== Reverting old RDS to private ===\n");

  // Remove SG rule
  try {
    aws(`ec2 revoke-security-group-ingress --group-id ${state.sgId} --protocol tcp --port 5432 --cidr ${state.myIp}/32`);
    console.log("Removed security group rule.");
  } catch {
    console.log("  (rule may already be removed)");
  }

  // Revert RDS to private
  aws(`rds modify-db-instance --db-instance-identifier ${OLD_DB_ID} --no-publicly-accessible --apply-immediately`);
  console.log("RDS set back to private.");

  // Remove/revert the IGW route
  if (state.hadExistingRoute) {
    // There was a route before (blackhole NAT) — delete the IGW route (it'll go back to blackhole or be gone)
    try {
      aws(`ec2 delete-route --route-table-id ${state.routeTableId} --destination-cidr-block 0.0.0.0/0`);
      console.log("Removed IGW route from route table.");
    } catch {
      console.log("  (could not remove route)");
    }
  } else {
    aws(`ec2 delete-route --route-table-id ${state.routeTableId} --destination-cidr-block 0.0.0.0/0`);
    console.log("Removed IGW route from route table.");
  }

  console.log("Old RDS fully reverted.\n");
}

// ============================================================================
// Phase 1b: Dump old database
// ============================================================================
type TableDump = { columns: string[]; rows: any[][]; sequences: { name: string; column: string }[] };

async function dumpDatabase(): Promise<{ schemaDDL: string[]; tables: Record<string, TableDump> }> {
  console.log("=== Dumping old database ===\n");

  const client = new Client({
    host: OLD_RDS_HOST,
    port: 5432,
    database: "cliniaacian",
    user: "cliniaacian_admin",
    password: "k6Ri1sUWQzrthhLZwfXYYf1JEpWBYLDe",
    ssl: { rejectUnauthorized: false },
  });

  console.log(`Connecting to ${OLD_RDS_HOST}...`);
  await client.connect();
  console.log("Connected.\n");

  const dump: Record<string, TableDump> = {};

  // Get all tables
  const tablesResult = await client.query(`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
  `);
  const tables = tablesResult.rows.map((r: any) => r.tablename);
  console.log(`Found ${tables.length} tables: ${tables.join(", ")}\n`);

  for (const table of tables) {
    const countResult = await client.query(`SELECT COUNT(*) as cnt FROM "${table}"`);
    const rowCount = parseInt(countResult.rows[0].cnt);

    const colResult = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `, [table]);
    const columns = colResult.rows.map((r: any) => r.column_name);

    const seqResult = await client.query(`
      SELECT pg_get_serial_sequence('"${table}"', column_name) as seq, column_name
      FROM information_schema.columns
      WHERE table_name = $1 AND table_schema = 'public' AND column_default LIKE 'nextval%'
    `, [table]);
    const sequences = seqResult.rows.filter((r: any) => r.seq).map((r: any) => ({ name: r.seq, column: r.column_name }));

    if (rowCount === 0) {
      console.log(`${table}: empty`);
      dump[table] = { columns, rows: [], sequences };
      continue;
    }

    console.log(`${table}: reading ${rowCount} rows...`);
    const dataResult = await client.query(`SELECT * FROM "${table}"`);
    const rows = dataResult.rows.map((row: any) =>
      columns.map((col) => {
        const v = row[col];
        return typeof v === "string" && v.includes(OLD_BUCKET) ? v.replaceAll(OLD_BUCKET, NEW_BUCKET) : v;
      })
    );
    dump[table] = { columns, rows, sequences };
  }

  // Drizzle migration tracking
  const drizzleTablesResult = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'drizzle'`);
  for (const { tablename } of drizzleTablesResult.rows) {
    const key = `drizzle.${tablename}`;
    const colResult = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'drizzle' AND table_name = $1 ORDER BY ordinal_position
    `, [tablename]);
    const columns = colResult.rows.map((r: any) => r.column_name);
    const dataResult = await client.query(`SELECT * FROM drizzle."${tablename}"`);
    const rows = dataResult.rows.map((row: any) => columns.map((col) => row[col]));
    console.log(`drizzle.${tablename}: ${rows.length} rows`);
    dump[key] = { columns, rows, sequences: [] };
  }

  // Schema DDL
  const schemaDDL: string[] = [];

  // Enums
  const enumResult = await client.query(`
    SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) as labels
    FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid
    JOIN pg_namespace n ON t.typnamespace = n.oid
    WHERE n.nspname = 'public' GROUP BY t.typname
  `);
  for (const row of enumResult.rows) {
    const labels = row.labels.split(",").map((l: string) => `'${l}'`).join(", ");
    schemaDDL.push(`DO $$ BEGIN CREATE TYPE "${row.typname}" AS ENUM (${labels}); EXCEPTION WHEN duplicate_object THEN null; END $$`);
  }

  // Table DDLs
  for (const table of tables) {
    const colsResult = await client.query(`
      SELECT column_name, udt_name, character_maximum_length, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position
    `, [table]);

    const cols = colsResult.rows.map((c: any) => {
      let type = c.udt_name;
      const typeMap: Record<string, string> = {
        int4: "integer", int8: "bigint", int2: "smallint", bool: "boolean",
        float8: "double precision", float4: "real", text: "text", timestamp: "timestamp",
        timestamptz: "timestamp with time zone", jsonb: "jsonb", json: "json",
        uuid: "uuid", serial: "serial", bigserial: "bigserial",
      };
      if (typeMap[type]) type = typeMap[type];
      else if (type === "varchar") type = c.character_maximum_length ? `varchar(${c.character_maximum_length})` : "varchar";
      else if (type.startsWith("_")) type = type.substring(1) + "[]";

      let def = `"${c.column_name}" ${type}`;
      if (c.column_default !== null) def += ` DEFAULT ${c.column_default}`;
      if (c.is_nullable === "NO") def += " NOT NULL";
      return def;
    });

    const pkResult = await client.query(`
      SELECT kcu.column_name FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'public' AND tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position
    `, [table]);

    let ddl = `CREATE TABLE IF NOT EXISTS "${table}" (\n  ${cols.join(",\n  ")}`;
    if (pkResult.rows.length > 0) {
      ddl += `,\n  PRIMARY KEY (${pkResult.rows.map((r: any) => `"${r.column_name}"`).join(", ")})`;
    }
    ddl += "\n)";
    schemaDDL.push(ddl);
  }

  // Indexes
  const idxResult = await client.query(`
    SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'
    AND indexname NOT IN (
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE constraint_type = 'PRIMARY KEY' AND table_schema = 'public'
    )
  `);
  for (const row of idxResult.rows) {
    schemaDDL.push(row.indexdef.replace(/CREATE INDEX/, "CREATE INDEX IF NOT EXISTS"));
  }

  await client.end();

  const totalRows = Object.values(dump).reduce((sum, t) => sum + t.rows.length, 0);
  console.log(`\nDump complete: ${Object.keys(dump).length} tables, ${totalRows} total rows.\n`);

  return { schemaDDL, tables: dump };
}

// ============================================================================
// Phase 2: Open SSM tunnel and restore to new database
// ============================================================================
function startTunnel(): ChildProcess {
  console.log("=== Opening SSM tunnel to new database ===\n");

  const bastionId = aws(
    `ec2 describe-instances` +
    ` --filters "Name=tag:Name,Values=aivota-prod-bastion" "Name=instance-state-name,Values=running"` +
    ` --query "Reservations[0].Instances[0].InstanceId" --output text`
  );
  if (!bastionId || bastionId === "None") {
    throw new Error("No running bastion instance found with tag 'aivota-prod-bastion'.");
  }
  console.log(`Bastion: ${bastionId}`);

  const newRdsHost = aws(
    `rds describe-db-instances --db-instance-identifier aivota-prod-postgres` +
    ` --query "DBInstances[0].Endpoint.Address" --output text`
  );
  if (!newRdsHost || newRdsHost === "None") {
    throw new Error("Could not find aivota-prod-postgres RDS instance.");
  }
  console.log(`New RDS: ${newRdsHost}`);
  console.log(`Tunnel: localhost:${TUNNEL_PORT} → ${newRdsHost}:5432\n`);

  const tunnel = spawn("aws", [
    "ssm", "start-session",
    "--target", bastionId,
    "--document-name", "AWS-StartPortForwardingSessionToRemoteHost",
    "--parameters", `host=${newRdsHost},portNumber=5432,localPortNumber=${TUNNEL_PORT}`,
    "--region", REGION,
  ], { stdio: "ignore" });

  return tunnel;
}

async function waitForTunnel(port: number, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const client = new Client({
        host: "localhost", port,
        database: "aivota", user: "aivota_admin",
        password: "e0KJRZQv_xglmyeKCkX89fAQEvnV2lDe",
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 3000,
      });
      await client.connect();
      await client.end();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`Tunnel on port ${port} did not become available within ${timeoutMs / 1000}s.`);
}

async function restoreDatabase(data: { schemaDDL: string[]; tables: Record<string, TableDump> }) {
  console.log("=== Restoring to new database ===\n");

  const { schemaDDL, tables: dump } = data;

  const client = new Client({
    host: "localhost",
    port: TUNNEL_PORT,
    database: "aivota",
    user: "aivota_admin",
    password: "e0KJRZQv_xglmyeKCkX89fAQEvnV2lDe",
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log("Connected to new database.\n");

  // Create schema if empty
  const existingTables = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  if (existingTables.rows.length === 0 && schemaDDL) {
    console.log("Creating schema...");
    for (const ddl of schemaDDL) {
      try { await client.query(ddl); }
      catch (e: any) {
        if (!e.message.includes("already exists")) console.log(`  Warning: ${e.message.split("\n")[0]}`);
      }
    }
    console.log("Schema created.\n");
  }

  await client.query("SET session_replication_role = 'replica'");
  await client.query("CREATE SCHEMA IF NOT EXISTS drizzle").catch(() => {});

  for (const [tableName, tableData] of Object.entries(dump)) {
    const { columns, rows, sequences } = tableData;
    if (rows.length === 0) { console.log(`${tableName}: empty, skipping`); continue; }

    const isDrizzle = tableName.startsWith("drizzle.");
    const quotedName = isDrizzle ? `drizzle."${tableName.replace("drizzle.", "")}"` : `"${tableName}"`;

    if (isDrizzle) {
      try {
        const colDefs = columns.map((c: string) => `"${c}" text`).join(", ");
        await client.query(`CREATE TABLE IF NOT EXISTS ${quotedName} (${colDefs})`);
      } catch {}
    }

    try { await client.query(`DELETE FROM ${quotedName}`); }
    catch (e: any) { console.log(`${tableName}: could not clear (${e.message.split("\n")[0]}), skipping`); continue; }

    console.log(`${tableName}: restoring ${rows.length} rows...`);
    let inserted = 0, errors = 0;

    for (const row of rows) {
      const placeholders = columns.map((_: any, i: number) => `$${i + 1}`).join(", ");
      const colNames = columns.map((c: string) => `"${c}"`).join(", ");
      try {
        await client.query(`INSERT INTO ${quotedName} (${colNames}) VALUES (${placeholders})`, row);
        inserted++;
      } catch (e: any) {
        errors++;
        if (errors <= 3) console.log(`  Error: ${e.message.split("\n")[0]}`);
      }
    }
    console.log(`  ${inserted} inserted${errors > 0 ? `, ${errors} errors` : ""}`);

    if (sequences) {
      for (const seq of sequences) {
        try {
          const maxResult = await client.query(`SELECT COALESCE(MAX("${seq.column}"), 0) + 1 as v FROM ${quotedName}`);
          await client.query(`SELECT setval('${seq.name}', ${maxResult.rows[0].v}, false)`);
        } catch {}
      }
    }
  }

  await client.query("SET session_replication_role = 'origin'");
  await client.end();
  console.log("\nRestore complete.\n");
}

// ============================================================================
// Main
// ============================================================================
(async () => {
  let tunnel: ChildProcess | undefined;
  let oldRdsState: OldRdsState | undefined;

  try {
    // Phase 1: Make old RDS public, dump, revert
    oldRdsState = makeOldRdsPublic();
    const data = await dumpDatabase();
    revertOldRds(oldRdsState);
    oldRdsState = undefined; // successfully reverted

    // Phase 2: Tunnel to new RDS and restore
    tunnel = startTunnel();
    console.log("Waiting for tunnel to establish...");
    await waitForTunnel(TUNNEL_PORT);
    console.log("Tunnel ready.\n");
    await restoreDatabase(data);

    console.log("=== Migration complete ===");
    console.log("Verify data, then delete this script: rm scripts/migrate-db.ts");
  } catch (e: any) {
    console.error(`\nFATAL: ${e.message}`);
    if (oldRdsState) {
      console.log("Attempting to revert old RDS...");
      try { revertOldRds(oldRdsState); } catch {}
    }
    process.exit(1);
  } finally {
    if (tunnel) { tunnel.kill(); }
  }
})();
