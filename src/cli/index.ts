// `npx byotalk db migrate` — creates the ByoTalk schema in YOUR Postgres and a least-privilege writer role.
// The admin URL is used only on your machine and never sent to ByoTalk.
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

const HELP = `Usage:
  npx byotalk db migrate --url <admin-postgres-url> [--schema byotalk] [--role byotalk_writer] [--no-role]
  npx byotalk db migrate --print-sql [--schema byotalk]

Creates schema "<schema>" (tables, indexes, schema_version) and a role with SELECT, INSERT, UPDATE on it
(no DELETE, no DDL). Prints the runtime connection string once: paste it into Dashboard → Storage.
`;

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const quoteLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function migrationSql(schema: string, role: string | null, password: string | null): string {
  const ddl = SCHEMA_SQL.replaceAll("__SCHEMA__", quoteIdent(schema));
  if (!role) return ddl;
  const r = quoteIdent(role);
  const pw = password ? ` PASSWORD ${quoteLiteral(password)}` : "";
  return `${ddl}
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(role)}) THEN
    CREATE ROLE ${r} LOGIN${pw};
  ELSE
    ALTER ROLE ${r} LOGIN${pw};
  END IF;
END $$;
GRANT USAGE ON SCHEMA ${quoteIdent(schema)} TO ${r};
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ${quoteIdent(schema)} TO ${r};
`;
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: "string" },
      schema: { type: "string", default: "byotalk" },
      role: { type: "string" },
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
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    process.stderr.write("Invalid --schema (lowercase letters, digits, underscore)\n");
    return 1;
  }
  const role = values["no-role"] ? null : (values.role ?? (schema === "byotalk" ? "byotalk_writer" : `${schema}_writer`));

  if (values["print-sql"]) {
    process.stdout.write(migrationSql(schema, role, null).replace(/ LOGIN;/g, " LOGIN PASSWORD 'choose-a-password';"));
    return 0;
  }
  if (!values.url) {
    process.stderr.write("--url is required (or use --print-sql)\n\n" + HELP);
    return 1;
  }

  let pg: typeof import("pg");
  try {
    pg = (await import("pg")).default as unknown as typeof import("pg");
  } catch {
    process.stderr.write("The 'pg' package is required: npm i -D pg (or run with npx, which installs it)\n");
    return 1;
  }
  const password = role ? randomBytes(24).toString("base64url") : null;
  const client = new pg.Client({ connectionString: values.url });
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query(migrationSql(schema, role, password));
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    process.stderr.write(`Migration failed: ${(err as Error).message}\n`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }

  process.stdout.write(`✔ Schema "${schema}" is at version ${SCHEMA_VERSION}\n`);
  if (role && password) {
    const u = new URL(values.url);
    u.username = role;
    u.password = password;
    if (!u.searchParams.has("sslmode")) u.searchParams.set("sslmode", "verify-full");
    process.stdout.write(`✔ Role "${role}" can SELECT, INSERT, UPDATE in "${schema}" (no DELETE, no DDL)\n\n`);
    process.stdout.write(`Runtime connection string (shown once — paste it into Dashboard → Storage → Database):\n\n  ${u.toString()}\n\n`);
    process.stdout.write(`Allowlist the ByoTalk egress IP shown in the dashboard on your database firewall.\n`);
  }
  return 0;
}

const isMain = typeof process !== "undefined" && process.argv[1] && /cli\.(js|ts)$|byotalk$/.test(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
