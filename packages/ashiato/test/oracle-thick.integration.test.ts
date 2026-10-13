/**
 * Oracle Thick mode (client=thick): runs when ASHIATO_TEST_ORACLE_URL and ASHIATO_TEST_ORACLE_LIB_DIR
 * (an Oracle Instant Client folder) are set. A file of its own: Thick mode, once on, is on for the
 * whole process.
 */
import { describe, expect, it } from "vitest";
import { connect } from "../src/adapters/index.js";
import { loadDriver } from "../src/adapters/load.js";

const url = process.env.ASHIATO_TEST_ORACLE_URL;
const libDir = process.env.ASHIATO_TEST_ORACLE_LIB_DIR;

describe.skipIf(!url || !libDir)("oracle adapter in Thick mode", () => {
  it("connects through Oracle Instant Client with client=thick", async () => {
    const u = new URL(url!);
    u.searchParams.set("client", "thick");
    u.searchParams.set("libDir", libDir!);
    const db = await connect(u.toString());
    try {
      const oracledb = await loadDriver<typeof import("oracledb")>("oracledb", "Oracle");
      expect(oracledb.thin).toBe(false);
      expect((await db.runQuery!("SELECT 1 AS n FROM dual", 10)).rows).toEqual([[1]]);
    } finally {
      await db.close();
    }
  });

  it("says where Instant Client was looked for when it isn't there", async () => {
    const u = new URL(url!);
    u.searchParams.set("client", "thick");
    u.searchParams.set("libDir", "/nonexistent");
    // Thick mode is already on from the test above: the same folder would be needed
    await expect(connect(u.toString())).rejects.toThrow(/Thick mode needs Oracle Instant Client in \/nonexistent/);
  });
});
