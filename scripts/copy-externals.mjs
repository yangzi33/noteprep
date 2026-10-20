// Copies the runtime closure of the worker's external packages out of a pnpm install (D-53).
// Usage: node scripts/copy-externals.mjs <src node_modules> <dest node_modules> <package>...
// Only dependencies and optionalDependencies are followed (never peers or dev tooling), and the pnpm layout is kept:
// real directories keep their relative path inside the virtual store, dependency links are recreated as relative symlinks.
import { cpSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export function copyClosure(srcRoot, destRoot, roots) {
  const src = realpathSync(srcRoot);
  const seen = new Set();
  const link = (from, to) => {
    // `from` is a path inside src; recreate it under destRoot pointing at the equivalent of `to`.
    const target = join(destRoot, relative(src, from));
    mkdirSync(dirname(target), { recursive: true });
    if (!lstatSyncOrNull(target)) symlinkSync(relative(dirname(target), join(destRoot, relative(src, to))), target);
  };
  const lstatSyncOrNull = (p) => { try { return lstatSync(p); } catch { return null; } };
  const visit = (realDir) => {
    if (seen.has(realDir)) return;
    seen.add(realDir);
    const rel = relative(src, realDir);
    if (rel.startsWith("..")) throw new Error(`${realDir} is outside ${src}`);
    cpSync(realDir, join(destRoot, rel), { recursive: true, verbatimSymlinks: true });
    const pkg = JSON.parse(readFileSync(join(realDir, "package.json"), "utf8"));
    // The directory holding this package's dependency links: .../node_modules (scoped packages sit one level deeper).
    const nm = dirname(realDir).endsWith("/node_modules") ? dirname(realDir) : dirname(dirname(realDir));
    const optional = pkg.optionalDependencies ?? {};
    for (const dep of Object.keys({ ...pkg.dependencies, ...optional })) {
      const linkPath = join(nm, dep);
      if (!lstatSyncOrNull(linkPath)) {
        if (dep in optional) continue; // optional dependency that was not installed
        throw new Error(`copy-externals: ${pkg.name} depends on "${dep}", which is not installed (and is not an optionalDependency)`);
      }
      const real = realpathSync(linkPath);
      link(linkPath, real);
      visit(real);
    }
  };
  rmSync(destRoot, { recursive: true, force: true });
  mkdirSync(destRoot, { recursive: true });
  for (const name of roots) {
    const linkPath = join(src, name);
    const real = realpathSync(linkPath);
    link(linkPath, real);
    visit(real);
  }
  return [...seen].map((d) => relative(src, d)).sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [srcRoot, destRoot, ...roots] = process.argv.slice(2);
  if (!srcRoot || !destRoot || roots.length === 0) throw new Error("usage: copy-externals <src> <dest> <package>...");
  const copied = copyClosure(srcRoot, destRoot, roots);
  console.log(`copied ${copied.length} packages`);
}
