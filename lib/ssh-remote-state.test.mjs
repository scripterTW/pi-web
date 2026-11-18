import assert from "node:assert/strict";
import test from "node:test";

async function loadStateModule() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./ssh-remote-state.ts");
}

async function loadRemoteModule() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./ssh-remote.ts");
}

test("readSshRemoteState returns the latest valid pi-ssh-remote-state entry", async () => {
  const { readSshRemoteState, SSH_REMOTE_STATE_ENTRY_TYPE } = await loadStateModule();
  assert.equal(readSshRemoteState([]), null);

  const entries = [
    { type: "message", message: { role: "user", content: "hi" } },
    {
      type: "custom",
      customType: SSH_REMOTE_STATE_ENTRY_TYPE,
      data: {
        connected: true,
        command: "ssh root@10.0.0.1 -p 22",
        cwd: "/var/app/one",
        routeRemoteTools: true,
        forwards: ["8080:127.0.0.1:80"],
      },
    },
    {
      type: "custom",
      customType: SSH_REMOTE_STATE_ENTRY_TYPE,
      data: {
        connected: false,
        command: "ssh root@10.0.0.1 -p 22",
        cwd: "/var/app/two",
      },
    },
  ];

  const state = readSshRemoteState(entries);
  assert.deepEqual(state, {
    connected: false,
    command: "ssh root@10.0.0.1 -p 22",
    cwd: "/var/app/two",
  });
});

test("isRemotePathAllowed enforces cwd boundary and prevents prefix/traversal escapes", async () => {
  const { isRemotePathAllowed } = await loadStateModule();

  assert.equal(isRemotePathAllowed("/var/app/project", "/var/app/project"), true);
  assert.equal(isRemotePathAllowed("/var/app/project/src/index.ts", "/var/app/project"), true);
  assert.equal(isRemotePathAllowed("/var/app/project/../other/secret", "/var/app/project"), false);
  assert.equal(isRemotePathAllowed("/var/app/project2/index.ts", "/var/app/project"), false);
  assert.equal(isRemotePathAllowed("/etc/passwd", "/var/app/project"), false);
  assert.equal(isRemotePathAllowed("/etc/passwd", "/"), true);
});

test("parseSshCommand extracts target, port, identity, and jump host", async () => {
  const { parseSshCommand } = await loadRemoteModule();

  const parsed = parseSshCommand("ssh -p 2222 -i ~/.ssh/id_ed25519 -J bastion@jump:2220 deploy@prod.example.com");
  assert.equal(parsed.username, "deploy");
  assert.equal(parsed.host, "prod.example.com");
  assert.equal(parsed.port, 2222);
  assert.ok(parsed.identityFile?.endsWith("/.ssh/id_ed25519"));
  assert.equal(parsed.jumps.length, 1);
  assert.equal(parsed.jumps[0].username, "bastion");
  assert.equal(parsed.jumps[0].host, "jump");
  assert.equal(parsed.jumps[0].port, 2220);
});
