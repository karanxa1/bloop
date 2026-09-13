#!/usr/bin/env node
// bloop eval harness — runs scripted multi-app tasks against /api/chat,
// collects the SSE trace, and verifies outcomes both in-trace (verify events)
// and externally (gh api read-back). Writes evals/report-<ts>.md.
//
// Usage: BLOOP_API=http://localhost:8899 node evals/run.mjs [--task N]

const API = process.env.BLOOP_API || "http://localhost:8899";
const EVAL_TOKEN = process.env.EVAL_TOKEN || "";
const REPO = "karanxa1/bloop-evals";

const MARK = `bloop-eval-${Date.now().toString(36)}`;

const TASKS = [
  {
    id: "read-only-github",
    prompt:
      "Using github tools only: call get_me, then list my 5 most recently pushed repos with star counts. Report as a short list.",
    expect: {
      toolApps: ["github"],
      minToolCalls: 2,
      mustWrite: false
    }
  },
  {
    id: "write-and-verify",
    prompt: `Create a GitHub issue in ${REPO} titled "${MARK} issue creation" with body "created by bloop eval". Then verify it exists by fetching it back, and attest.`,
    expect: {
      toolApps: ["github"],
      minToolCalls: 2,
      mustWrite: true,
      mustVerify: true,
      external: {
        type: "github_issue_title_contains",
        repo: REPO,
        needle: `${MARK} issue creation`
      }
    }
  },
  {
    id: "research-then-write",
    prompt: `Use deepwiki to find out what the cloudflare/agents repo does (one paragraph max). Then create a GitHub issue in ${REPO} titled "${MARK} research summary" whose body is your summary. Verify the issue exists and attest.`,
    expect: {
      toolApps: ["github", "deepwiki"],
      minToolCalls: 3,
      mustWrite: true,
      mustVerify: true,
      external: {
        type: "github_issue_title_contains",
        repo: REPO,
        needle: `${MARK} research summary`
      }
    }
  },
  {
    id: "multi-app-digest",
    prompt:
      "List my 3 most recently pushed github repos. Then use cf-docs to look up one fact about Cloudflare Durable Objects. Report: repo names + the fact. Keep it short.",
    expect: {
      toolApps: ["github", "cf-docs"],
      minToolCalls: 2,
      mustWrite: false
    }
  },
  {
    id: "sandbox-code-exec",
    prompt:
      "Use run_code to compute the 15th fibonacci number in python. Report just the number and the approach.",
    expect: {
      toolApps: [],
      toolNames: ["run_code"],
      minToolCalls: 1,
      mustWrite: false
    }
  },
  {
    id: "failure-transparency",
    prompt:
      "Try to create a GitHub issue in the repository nonexistent-owner-xyz/definitely-not-a-repo-123 titled 'x'. It will fail — that is expected. Report exactly what happened and do NOT claim success.",
    expect: {
      toolApps: ["github"],
      minToolCalls: 1,
      mustWrite: false,
      mustNotFalselyVerify: true,
      expectError: true
    }
  }
];

function parseSSE(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const ev = block.match(/^event: (.+)$/m);
    const da = block.match(/^data: (.*)$/ms);
    if (ev && da) {
      try {
        events.push({ type: ev[1].trim(), data: JSON.parse(da[1].trim()) });
      } catch {
        events.push({ type: ev[1].trim(), data: da[1].trim() });
      }
    }
  }
  return events;
}

async function runTask(task) {
  const started = Date.now();
  const res = await fetch(`${API}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(EVAL_TOKEN ? { authorization: `Bearer ${EVAL_TOKEN}` } : {})
    },
    body: JSON.stringify({
      message: task.prompt
    })
  });
  const text = await res.text();
  const events = parseSSE(text);

  const toolCalls = events.filter((e) => e.type === "tool_call");
  const toolResults = events.filter((e) => e.type === "tool_result");
  const verifies = events.filter((e) => e.type === "verify");
  const errors = events.filter((e) => e.type === "error");
  const reply = events
    .filter((e) => e.type === "delta")
    .map((e) => e.data.text ?? "")
    .join("");

  const appsUsed = new Set(
    toolCalls.map((e) => e.data.app).filter((a) => a && a !== "bloop" && a !== "local")
  );
  const toolNames = new Set(toolCalls.map((e) => e.data.name));
  const writes = toolResults.filter(
    (e) =>
      e.data.ok &&
      /create|update|delete|send|post|comment|merge|close|add|remove|set|write|invite|reply|assign|label|move/i.test(
        e.data.name ?? ""
      )
  );

  const checks = [];
  const check = (name, ok, detail = "") =>
    checks.push({ name, ok, detail });

  check("responded", reply.length > 0 || toolCalls.length > 0);
  check(
    "apps used",
    task.expect.toolApps.every((a) => appsUsed.has(a)),
    [...appsUsed].join(",")
  );
  if (task.expect.toolNames) {
    check(
      "tools used",
      task.expect.toolNames.every((n) => toolNames.has(n)),
      [...toolNames].join(",")
    );
  }
  check(
    "min tool calls",
    toolCalls.length >= task.expect.minToolCalls,
    `${toolCalls.length} >= ${task.expect.minToolCalls}`
  );
  if (task.expect.mustWrite) {
    check("performed a write", writes.length > 0, `${writes.length} writes`);
  }
  if (task.expect.mustVerify) {
    check(
      "attested (verify event)",
      verifies.length > 0,
      verifies.map((v) => v.data.hash?.slice(0, 8)).join(",")
    );
  }
  if (task.expect.mustNotFalselyVerify) {
    check(
      "did NOT falsely attest",
      verifies.length === 0,
      `${verifies.length} verify events`
    );
    check(
      "reported the failure",
      /fail|error|not found|404|couldn|unable/i.test(reply),
      ""
    );
  }
  if (task.expect.expectError) {
    // tool error or failed result should appear somewhere
    const failedTool = toolResults.some((e) => e.data.ok === false);
    check(
      "failure surfaced in trace",
      failedTool || errors.length > 0 || /fail|error|404/i.test(reply),
      `failedTools=${failedTool} errors=${errors.length}`
    );
  }

  // External verification — ground truth outside the agent's own trace
  let external = null;
  if (task.expect.external?.type === "github_issue_title_contains") {
    const { execSync } = await import("node:child_process");
    try {
      const out = execSync(
        `gh issue list -R ${task.expect.external.repo} --search "in:title ${task.expect.external.needle}" --json title,number,url --limit 5`,
        { encoding: "utf8" }
      );
      const issues = JSON.parse(out);
      external = {
        name: "external: issue exists on github",
        ok: issues.length > 0,
        detail: issues[0]?.url ?? "not found"
      };
    } catch (e) {
      external = { name: "external check", ok: false, detail: String(e).slice(0, 200) };
    }
    checks.push(external);
  }

  return {
    id: task.id,
    ms: Date.now() - started,
    checks,
    passed: checks.every((c) => c.ok),
    stats: {
      toolCalls: toolCalls.length,
      apps: [...appsUsed],
      verifies: verifies.length,
      errors: errors.length,
      replyLen: reply.length
    },
    reply: reply.slice(0, 400)
  };
}

async function main() {
  const onlyIdx = process.argv.includes("--task")
    ? Number(process.argv[process.argv.indexOf("--task") + 1])
    : null;

  const health = await fetch(`${API}/api/health`).then((r) => r.json());
  console.log(`backend: ${API} model=${health.model}`);
  console.log(`servers: ${health.servers.map((s) => `${s.name}(${s.tools})`).join(", ")}\n`);

  const results = [];
  for (const [i, task] of TASKS.entries()) {
    if (onlyIdx !== null && i !== onlyIdx) continue;
    process.stdout.write(`▶ ${task.id} ... `);
    const r = await runTask(task);
    results.push(r);
    console.log(`${r.passed ? "PASS" : "FAIL"} (${(r.ms / 1000).toFixed(1)}s)`);
    for (const c of r.checks.filter((c) => !c.ok)) {
      console.log(`    ✗ ${c.name} ${c.detail}`);
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const lines = [
    `# bloop eval report — ${new Date().toISOString()}`,
    ``,
    `backend: ${API} · model: ${health.model}`,
    `servers: ${health.servers.map((s) => `${s.name} (${s.tools} tools)`).join(", ")}`,
    ``,
    `## ${passed}/${results.length} tasks passed`,
    ``
  ];
  for (const r of results) {
    lines.push(`### ${r.passed ? "✅" : "❌"} ${r.id} — ${(r.ms / 1000).toFixed(1)}s`);
    lines.push(
      `tools: ${r.stats.toolCalls} · apps: ${r.stats.apps.join(",") || "-"} · verifies: ${r.stats.verifies} · errors: ${r.stats.errors}`
    );
    for (const c of r.checks) {
      lines.push(`- ${c.ok ? "✅" : "❌"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
    }
    lines.push(`> ${r.reply.replace(/\n/g, " ").slice(0, 300)}`, ``);
  }

  const fs = await import("node:fs");
  const path = `evals/report-${Date.now()}.md`;
  fs.writeFileSync(path, lines.join("\n"));
  console.log(`\n${passed}/${results.length} passed — report → ${path}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
