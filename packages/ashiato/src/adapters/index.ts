import type { DbAdapter } from "./types.js";

export type { DbAdapter } from "./types.js";

/**
 * Opens a read-only adapter from a connection URL:
 *   sqlite:./dev.db
 *   mssql://user:pass@host:1433/database?encrypt=false
 *   oracle://user:pass@host:1521/service?schema=OWNER
 *   postgres://user:pass@host:5432/database
 *   mysql://user:pass@host:3306/database
 */
export async function connect(connection: string): Promise<DbAdapter> {
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
