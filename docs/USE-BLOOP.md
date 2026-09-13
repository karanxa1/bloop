# using bloop — the full feature tour

bloop is live at **https://bloop.rough-cell-383c.workers.dev** (landing at `/`, app at `/app`).

Paste the prompts below in order. Each one exercises a different subsystem, and every
mutation is independently verified by read-back and recorded in the hash-chained proof trace.

---

## the one-shot mega prompt

Paste this to exercise most of the stack in a single run. Use **deep** mode.

> Research the Cloudflare Workers docs for the current D1 API, then check my GitHub for a repo
> that uses it. Search the web for anything that changed in the last month. Run python to compute
> the first 20 fibonacci numbers. Create a file `notes/findings.md` in the workspace summarising
> what you found, then run `ls -la notes` to confirm it exists. Generate an image of a small green
> blob reading a book. Save a lesson about anything that surprised you, and remember that I prefer
> short answers. Finish with a plan of what you did and prove each write.

---

## feature-by-feature prompts

| # | Feature | Prompt |
|---|---|---|
| 1 | **MCP apps (read)** | `Using github only: list my 5 most recently pushed repos with star counts.` |
| 2 | **MCP apps (write + verify)** | `Create a github issue in karanxa1/bloop-evals titled "bloop demo <timestamp>" with a one-line body, then read it back to confirm it exists.` |
| 3 | **Multi-app in one run** | `Summarise the top 3 open issues in karanxa1/bloop-evals, then search the Cloudflare docs for how D1 migrations work, and give me one combined digest.` |
| 4 | **Tool search (`load_tools`)** | `I need to query Sentry for recent errors — find the right tool for that and use it.` |
| 5 | **Sandbox code (`run_code`)** | `Use run_code to compute the first 20 fibonacci numbers and print them.` |
| 6 | **Sandbox JS** | `Use run_code with javascript to reverse the string "bloop" and print it.` |
| 7 | **Workspace files** | `Write a file hello.py that prints "hi from bloop", then run it, then list the workspace.` |
| 8 | **Workspace shell** | `In the workspace, create a venv, install requests, and print its version.` |
| 9 | **Image generation** | `Generate an image of a tiny lime-green blob surfing a wave, flat vector style.` |
| 10 | **Image editing** | *(attach a PNG)* `Edit this image so the background is solid lime green.` |
| 11 | **Vision** | *(attach a screenshot)* `What's wrong with this UI? List the issues you can see.` |
| 12 | **Browse (headless)** | `Browse https://developers.cloudflare.com/d1/ and tell me the current API for prepared statements.` |
| 13 | **Browser handoff (login)** | `Open a live browser at https://github.com/login and hand it to me so I can sign in, then take over.` |
| 14 | **Subagents (`delegate`)** | `Delegate two research subagents in parallel: one on D1 vs Postgres for edge apps, one on MCP transport choices. Merge their findings.` |
| 15 | **Parallel tool calls** | `Fetch the latest release of cloudflare/workers-rs and of cloudflare/durable-objects in parallel and compare them.` |
| 16 | **Memory** | `Remember that I prefer terse answers and that my timezone is IST.` then later: `What do you know about my preferences?` |
| 17 | **Context file** | `Update my context file to say I'm building an agent on Cloudflare Workers and I dislike verbose output.` |
| 18 | **Lessons file** | `Save a lesson: the workers.dev → workers.dev fetch fails with error 1042; use a service binding instead.` |
| 19 | **Skills** | `Create a skill called "changelog" that writes a keep-a-changelog entry from my recent commits, then use it.` |
| 20 | **Think mode** | *(mode: think)* `Design the schema for a multi-tenant audit log before writing anything.` |
| 21 | **Deep mode** | *(mode: deep)* `Research how MCP OAuth discovery works end to end and cite your sources.` |
| 22 | **Proof trace** | Click **proof** after any run — every external write shows a verify row with a hash and a read-back link. |
| 23 | **Voice** | Tap the orb in the composer and talk — the relay streams audio to the agent and speaks replies. |
| 24 | **Marketplace** | **mcp servers** → paste any URL. bloop probes it and tells you if it needs OAuth, a token, or nothing. |
| 25 | **Skills marketplace** | **tools** tab → install a catalog skill, or write your own in the editor. |
| 26 | **Built-in toggles** | **tools** tab → disable tools you don't want the model to reach for. |
| 27 | **Model selector** | Header dropdown — `gpt-5.6-terra` (default), `gpt-5.6-sol`, `gpt-5.6-luna`. |
| 28 | **History** | Sidebar — every conversation persists with its full trace and can be reopened. |

---

## things worth knowing

- **Modes**: `quick` is the default, `think` forces a planning pass first, `deep` raises the
  iteration cap, collects sources, and is the right choice for the mega prompt.
- **Verification**: bloop doesn't trust its own writes. After a mutation it reads the resource
  back and records an `attest` entry; the proof panel shows `verified` vs `unverified` honestly.
- **Sandbox isolation**: your sandbox id is derived from your user id, so your code, files, and
  shells are yours alone.
- **Costs**: the sandbox scales to zero when idle and each run is capped on iterations, output
  size, and timeout — sized for a handful of users, not a fleet.
- **Adding an app**: paste just the URL. bloop detects whether the server is open, needs a bearer
  token, or speaks OAuth, and preselects the right flow.
