/** Drivers are optional peer dependencies: install only the one for your database. */
export async function loadDriver<T>(pkg: string, label: string): Promise<T> {
  try {
    const mod = (await import(pkg)) as { default?: T } & T;
    return (mod.default ?? mod) as T;
  } catch (e) {
    const base = pkg.split("/")[0];
    throw new Error(`${label} support needs the "${base}" package. Install it with: npm install ${base}\n(${(e as Error).message})`);
  }
}
