import fs from "node:fs";

for (const path of ["dist", "dist-sidecar"]) {
  fs.rmSync(path, { recursive: true, force: true });
}
