// `npx byotalk db migrate` — creates the ByoTalk tables/collections in YOUR database (PostgreSQL, MySQL/MariaDB or
// MongoDB) and a least-privilege writer. The admin URL is used only on your machine and never sent to ByoTalk.
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { MONGODB_SPEC, MYSQL_SQL, POSTGRES_SQL, SCHEMA_VERSION } from "./schema.js";

const HELP = `Usage:
  npx byotalk db migrate --url <admin-database-url> [--schema byotalk] [--role <name>] [--no-role]
  npx byotalk db migrate --print-sql --engine postgres|mysql [--schema byotalk]

Supported URLs: postgres://…  mysql://… (MariaDB too)  mongodb://… or mongodb+srv://…
Creates the ByoTalk tables (Postgres: schema "<schema>"; MySQL/MongoDB: "<schema>_*" tables/collections in the
URL's database) and a writer that can only read, insert and update them (no delete, no DDL). Prints the runtime
connection string once: paste it into Dashboard → Storage → Database.
`;

type Engine = "postgres" | "mysql" | "mongodb";

const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;
const ql = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function detectEngine(url: string): Engine | null {
  if (/^postgres(ql)?:\/\//.test(url)) return "postgres";
  if (/^(mysql|mariadb):\/\//.test(url)) return "mysql";
  if (/^mongodb(\+srv)?:\/\//.test(url)) return "mongodb";
  return null;
}

// ------------------------------------------------------------------ PostgreSQL

export function migrationSql(schema: string, role: string | null, password: string | null): string {
  const ddl = POSTGRES_SQL.replaceAll("__SCHEMA__", qi(schema));
  if (!role) return ddl;
  const r = qi(role);
  const pw = password ? ` PASSWORD ${ql(password)}` : "";
  return `${ddl}
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${ql(role)}) THEN
    CREATE ROLE ${r} LOGIN${pw};
  ELSE
    ALTER ROLE ${r} LOGIN${pw};
  END IF;
END $$;
GRANT USAGE ON SCHEMA ${qi(schema)} TO ${r};
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ${qi(schema)} TO ${r};
`;
}

async function migratePostgres(url: string, schema: string, role: string | null, password: string | null) {
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(migrationSql(schema, role, password));
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}

// ------------------------------------------------------------------ MySQL / MariaDB

const MYSQL_TABLES = ["schema_version", "users", "conversations", "conversation_members", "messages"];

export function mysqlStatements(schema: string): string[] {
  return MYSQL_SQL.replaceAll("__P__", `${schema}_`)
    .split(/^;;$/m)
    .map((s) => s.replace(/^--.*$/gm, "").trim())
    .filter(Boolean);
}

async function migrateMysql(url: string, schema: string, role: string | null, password: string | null) {
  const mysql = (await import("mysql2/promise")).default;
  const u = new URL(url);
  const database = decodeURIComponent(u.pathname.slice(1));
  if (!database) throw new Error("The URL must name a database: mysql://user:pass@host:3306/<database>");
  const sslMode = (u.searchParams.get("ssl-mode") ?? "").toUpperCase();
  const c = await mysql.createConnection({
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database,
    ssl: sslMode === "DISABLED" ? undefined : { rejectUnauthorized: sslMode !== "REQUIRED" },
  });
  try {
    for (const sql of mysqlStatements(schema)) await c.query(sql);
    if (role && password) {
      await c.query("CREATE USER IF NOT EXISTS ?@'%' IDENTIFIED BY ?", [role, password]);
      await c.query("ALTER USER ?@'%' IDENTIFIED BY ?", [role, password]);
      for (const t of MYSQL_TABLES) await c.query(`GRANT SELECT, INSERT, UPDATE ON \`${database}\`.\`${schema}_${t}\` TO ?@'%'`, [role]);
    }
  } finally {
    await c.end().catch(() => {});
  }
}

// ------------------------------------------------------------------ MongoDB

async function migrateMongo(url: string, schema: string, role: string | null, password: string | null): Promise<boolean> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  try {
    const db = client.db();
    const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
    for (const [t, def] of Object.entries(MONGODB_SPEC.collections)) {
      const name = `${schema}_${t}`;
      if (!existing.has(name)) await db.createCollection(name);
      for (const ix of def.indexes as readonly { key: Record<string, 1 | -1>; unique?: boolean }[]) {
        await db.collection(name).createIndex(ix.key, { unique: !!ix.unique });
      }
    }
    await db.collection(`${schema}_schema_version`).updateOne({ version: SCHEMA_VERSION }, { $setOnInsert: { version: SCHEMA_VERSION, applied_at: new Date() } }, { upsert: true });
    if (!role || !password) return false;
    const privileges = ["schema_version", "users", "conversations", "conversation_members", "messages"].map((t) => ({
      resource: { db: db.databaseName, collection: `${schema}_${t}` },
      actions: ["find", "insert", "update"],
    }));
    const roleName = `${schema}_writer_role`;
    try {
      const roles = await db.command({ rolesInfo: roleName });
      await db.command(roles.roles?.length ? { updateRole: roleName, privileges, roles: [] } : { createRole: roleName, privileges, roles: [] });
      const users = await db.command({ usersInfo: role });
      await db.command(users.users?.length ? { updateUser: role, pwd: password, roles: [roleName] } : { createUser: role, pwd: password, roles: [roleName] });
      return true;
    } catch (err) {
      process.stdout.write(
        `! Could not create the database user (${(err as Error).message}).\n  Create a user with find/insert/update on the ${schema}_* collections (or readWrite on ${db.databaseName}) in your MongoDB console (Atlas: Database Access) and paste its connection string into the dashboard.\n`,
      );
      return false;
    }
  } finally {
    await client.close().catch(() => {});
  }
}

// ------------------------------------------------------------------ main

function runtimeUrl(engine: Engine, adminUrl: string, role: string, password: string): string {
  if (engine === "mongodb") {
    const db = adminUrl.replace(/^mongodb(\+srv)?:\/\/[^/]*\//, "").split("?")[0];
    const withCreds = adminUrl.replace(/^(mongodb(?:\+srv)?:\/\/)(?:[^@/]*@)?/, `$1${encodeURIComponent(role)}:${encodeURIComponent(password)}@`);
    return /[?&]authSource=/.test(withCreds) ? withCreds : `${withCreds}${withCreds.includes("?") ? "&" : "?"}authSource=${db}`;
  }
  const u = new URL(adminUrl);
  u.username = role;
  u.password = password;
  if (engine === "postgres" && !u.searchParams.has("sslmode")) u.searchParams.set("sslmode", "verify-full");
  return u.toString();
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: "string" },
      schema: { type: "string", default: "byotalk" },
      role: { type: "string" },
      engine: { type: "string" },
      "no-role": { type: "boolean", default: false },
      "print-sql": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals[0] !== "db" || positionals[1] !== "migrate") {
    process.stdout.write(HELP);
    return values.help ? 0 : 1;
  }
  const schema = values.schema!;
  if (!/^[a-z_][a-z0-9_]{0,40}$/.test(schema)) {
    process.stderr.write("Invalid --schema (lowercase letters, digits, underscore)\n");
    return 1;
  }
  const role = values["no-role"] ? null : (values.role ?? (schema === "byotalk" ? "byotalk_writer" : `${schema}_writer`));

  if (values["print-sql"]) {
    const engine = (values.engine ?? "postgres") as Engine;
    if (engine === "mysql") {
      const stmts = mysqlStatements(schema).map((s) => `${s};`);
      if (role) {
        stmts.push(`CREATE USER IF NOT EXISTS '${role}'@'%' IDENTIFIED BY 'choose-a-password';`);
        for (const t of MYSQL_TABLES) stmts.push(`GRANT SELECT, INSERT, UPDATE ON \`<database>\`.\`${schema}_${t}\` TO '${role}'@'%';`);
      }
      process.stdout.write(`${stmts.join("\n\n")}\n`);
    } else if (engine === "postgres") {
      process.stdout.write(migrationSql(schema, role, null).replace(/ LOGIN;/g, " LOGIN PASSWORD 'choose-a-password';"));
    } else {
      process.stderr.write("--print-sql supports --engine postgres or mysql (MongoDB needs no SQL: run migrate with --url)\n");
      return 1;
    }
    return 0;
  }
  if (!values.url) {
    process.stderr.write("--url is required (or use --print-sql)\n\n" + HELP);
    return 1;
  }
  const engine = detectEngine(values.url);
  if (!engine) {
    process.stderr.write("Unsupported URL: use postgres://, mysql:// or mongodb://\n");
    return 1;
  }

  const password = role ? randomBytes(24).toString("base64url") : null;
  let userCreated = !!role;
  try {
    if (engine === "postgres") await migratePostgres(values.url, schema, role, password);
    else if (engine === "mysql") await migrateMysql(values.url, schema, role, password);
    else userCreated = await migrateMongo(values.url, schema, role, password);
  } catch (err) {
    const msg = (err as Error).message;
    if (/Cannot find (package|module)/.test(msg)) {
      process.stderr.write(`The database driver is missing: npm i -D ${engine === "postgres" ? "pg" : engine === "mysql" ? "mysql2" : "mongodb"}\n`);
    } else {
      process.stderr.write(`Migration failed: ${msg}\n`);
    }
    return 1;
  }

  const where = engine === "postgres" ? `schema "${schema}"` : `"${schema}_*" ${engine === "mongodb" ? "collections" : "tables"}`;
  process.stdout.write(`✔ ${where} at version ${SCHEMA_VERSION}\n`);
  if (role && password && userCreated) {
    process.stdout.write(`✔ "${role}" can read, insert and update ${where} (no delete, no DDL)\n\n`);
    process.stdout.write(`Runtime connection string (shown once — paste it into Dashboard → Storage → Database):\n\n  ${runtimeUrl(engine, values.url, role, password)}\n\n`);
    process.stdout.write("Allowlist the ByoTalk egress IP shown in the dashboard on your database firewall.\n");
  }
  return 0;
}

const isMain = typeof process !== "undefined" && process.argv[1] && /cli\.(js|ts)$|byotalk$/.test(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
