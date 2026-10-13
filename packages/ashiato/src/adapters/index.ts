import type { DbAdapter } from "./types.js";

export type { DbAdapter } from "./types.js";

/**
 * Opens a read-only adapter from a connection URL:
 *   sqlite:./dev.db
 *   mssql://user:pass@host:1433/database?encrypt=true
 *   oracle://user:pass@host:1521/service?schema=OWNER   (client=thick for Thick mode)
 *   postgres://user:pass@host:5432/database
 *   mysql://user:pass@host:3306/database
 */
export async function connect(connection: string): Promise<DbAdapter> {
  try {
    return await open(connection);
  } catch (e) {
    if (e instanceof URIError) {
      throw new Error("Could not read the user name or password in the URL: percent-encode special characters (% → %25, @ → %40, : → %3A)");
    }
    throw e;
  }
}

/** The adapter's `dialect` for a connection URL, without connecting. Undefined when the URL isn't one ashiato reads. */
export function dialectOf(connection: string): string | undefined {
  if (connection.startsWith("sqlite:")) return "sqlite";
  const scheme = /^([a-z]+):/i.exec(connection)?.[1]?.toLowerCase();
  const dialects: Record<string, string> = { mssql: "mssql", sqlserver: "mssql", oracle: "oracle", postgres: "postgres", postgresql: "postgres", mysql: "mysql", mariadb: "mysql" };
  return scheme ? dialects[scheme] : undefined;
}

async function open(connection: string): Promise<DbAdapter> {
  if (connection.startsWith("sqlite:")) {
    const { connectSqlite } = await import("./sqlite.js");
    return connectSqlite(connection.slice("sqlite:".length).replace(/^\/\//, ""));
  }
  const url = new URL(connection);
  switch (url.protocol) {
    case "mssql:":
    case "sqlserver:": {
      const { connectMssql } = await import("./mssql.js");
      return connectMssql(url);
    }
    case "oracle:": {
      const { connectOracle } = await import("./oracle.js");
      return connectOracle(url);
    }
    case "postgres:":
    case "postgresql:": {
      const { connectPostgres } = await import("./postgres.js");
      return connectPostgres(url);
    }
    case "mysql:":
    case "mariadb:": {
      const { connectMysql } = await import("./mysql.js");
      if (url.protocol === "mariadb:") url.protocol = "mysql:";
      return connectMysql(url);
    }
    default:
      throw new Error(`Unsupported database URL: ${url.protocol} (use sqlite:, mssql:, oracle:, postgres: or mysql:)`);
  }
}
