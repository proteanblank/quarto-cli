## Adding a new Typescript dependency to the project

FIXME THIS ALL NEEDS UPDATING FOR 1.46.3 AND LATER

We vendor all external dependencies to avoid downloads during the execution of quarto in installed environments. To add a new dependency, edit the `./src/import_map.json` file.

- If the dependency comes from the Deno standard library, make sure you match the version number (otherwise we can end up with duplicate imports from different versions)

- If the dependency is used in our test suite, add an explicit import statement to `tests/test-deps.ts`. This file is combined with `quarto.ts` in the vendoring process described below, and ensures that the dependencies are visible without having to scan the entire test suite.

- If the dependency is meant to be exposed to quarto typescript script (through `quarto run`), then add the import to `package/scripts/deno_std/deno_std.ts` as well (notice the slightly different syntax there, and adapt accordingly).

Then, rerun `./configure.sh`, which calls the `./package/scripts/vendoring/vendor.sh` scripts to update the deno cache with the downloaded dependencies. 