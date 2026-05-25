import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const installScript = path.join(repoRoot, "scripts", "install.sh");

test("quick install shell script supports dry-run without side effects", async () => {
  const { stdout } = await execFileAsync("sh", [installScript, "--dry-run", "--skip-setup"], {
    cwd: repoRoot,
  });

  assert.match(stdout, /npm install -g codepatchbay/);
  assert.doesNotMatch(stdout, /cpb setup --recommended/);
});

test("quick install shell script dry-runs prerequisite installs for a clean machine", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cpb-install-sh-"));
  try {
    const fakeBrew = path.join(tmp, "brew");
    await writeFile(fakeBrew, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(fakeBrew, 0o755);

    const { stdout } = await execFileAsync("/bin/sh", [installScript, "--dry-run", "--skip-setup"], {
      cwd: repoRoot,
      env: {
        PATH: tmp,
      },
    });

    assert.match(stdout, /Missing prerequisites: node npm git gh/);
    assert.match(stdout, /\+ brew install node git gh/);
    assert.match(stdout, /\+ npm install -g codepatchbay/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("quick install shell script prompts when gh is not authenticated", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cpb-install-sh-"));
  try {
    const log = path.join(tmp, "commands.log");
    const fakeNpm = path.join(tmp, "npm");
    const fakeCpb = path.join(tmp, "cpb");
    const fakeNode = path.join(tmp, "node");
    const fakeGit = path.join(tmp, "git");
    const fakeGh = path.join(tmp, "gh");

    await writeFile(fakeNpm, `#!/bin/sh\necho "npm $*" >> ${JSON.stringify(log)}\n`, "utf8");
    await writeFile(fakeCpb, `#!/bin/sh\necho "cpb $*" >> ${JSON.stringify(log)}\n`, "utf8");
    await writeFile(fakeNode, "#!/bin/sh\nexit 0\n", "utf8");
    await writeFile(fakeGit, "#!/bin/sh\nexit 0\n", "utf8");
    await writeFile(
      fakeGh,
      `#!/bin/sh\necho "gh $*" >> ${JSON.stringify(log)}\nif [ "$1 $2" = "auth status" ]; then exit 1; fi\nexit 0\n`,
      "utf8"
    );
    await Promise.all([fakeNpm, fakeCpb, fakeNode, fakeGit, fakeGh].map((file) => chmod(file, 0o755)));

    const { stdout } = await execFileAsync("/bin/sh", [installScript, "--recommended"], {
      cwd: repoRoot,
      env: {
        PATH: tmp,
      },
    });

    const commands = await readFile(log, "utf8");
    assert.match(commands, /gh auth status/);
    assert.doesNotMatch(commands, /gh auth login/);
    assert.match(stdout, /GitHub CLI is not authenticated/);
    assert.match(stdout, /gh auth login/);
    assert.match(commands, /cpb setup --recommended/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("quick install shell script can launch gh auth login when requested", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cpb-install-sh-"));
  try {
    const log = path.join(tmp, "commands.log");
    const fakeNpm = path.join(tmp, "npm");
    const fakeCpb = path.join(tmp, "cpb");
    const fakeNode = path.join(tmp, "node");
    const fakeGit = path.join(tmp, "git");
    const fakeGh = path.join(tmp, "gh");

    await writeFile(fakeNpm, `#!/bin/sh\necho "npm $*" >> ${JSON.stringify(log)}\n`, "utf8");
    await writeFile(fakeCpb, `#!/bin/sh\necho "cpb $*" >> ${JSON.stringify(log)}\n`, "utf8");
    await writeFile(fakeNode, "#!/bin/sh\nexit 0\n", "utf8");
    await writeFile(fakeGit, "#!/bin/sh\nexit 0\n", "utf8");
    await writeFile(
      fakeGh,
      `#!/bin/sh\necho "gh $*" >> ${JSON.stringify(log)}\nif [ "$1 $2" = "auth status" ]; then exit 1; fi\nexit 0\n`,
      "utf8"
    );
    await Promise.all([fakeNpm, fakeCpb, fakeNode, fakeGit, fakeGh].map((file) => chmod(file, 0o755)));

    await execFileAsync("/bin/sh", [installScript, "--recommended", "--gh-auth-login"], {
      cwd: repoRoot,
      env: {
        PATH: tmp,
      },
    });

    const commands = await readFile(log, "utf8");
    assert.match(commands, /gh auth status/);
    assert.match(commands, /gh auth login/);
    assert.match(commands, /cpb setup --recommended/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("quick install shell script installs package and runs recommended setup", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cpb-install-sh-"));
  try {
    const log = path.join(tmp, "commands.log");
    const fakeNpm = path.join(tmp, "npm");
    const fakeCpb = path.join(tmp, "cpb");
    const fakeNode = path.join(tmp, "node");
    const fakeGit = path.join(tmp, "git");
    const fakeGh = path.join(tmp, "gh");
    await writeFile(fakeNpm, `#!/bin/sh\necho "npm $*" >> ${JSON.stringify(log)}\n`, "utf8");
    await writeFile(fakeCpb, `#!/bin/sh\necho "cpb $*" >> ${JSON.stringify(log)}\n`, "utf8");
    await writeFile(fakeNode, "#!/bin/sh\nexit 0\n", "utf8");
    await writeFile(fakeGit, "#!/bin/sh\nexit 0\n", "utf8");
    await writeFile(fakeGh, `#!/bin/sh\necho "gh $*" >> ${JSON.stringify(log)}\nexit 0\n`, "utf8");
    await Promise.all([fakeNpm, fakeCpb, fakeNode, fakeGit, fakeGh].map((file) => chmod(file, 0o755)));

    await execFileAsync("sh", [installScript, "--recommended"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NPM_BIN: fakeNpm,
        CPB_BIN: fakeCpb,
        NODE_BIN: fakeNode,
        GIT_BIN: fakeGit,
        GH_BIN: fakeGh,
      },
    });

    const commands = await readFile(log, "utf8");
    assert.match(commands, /npm install -g codepatchbay/);
    assert.match(commands, /gh auth status/);
    assert.match(commands, /cpb setup --recommended/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
