# IdeaHub Agent Skill Evaluation

IdeaHub separates four questions that must not share a score:

1. Are the project Skill files structurally valid and do required safety rules still exist?
2. Does a named real agent produce a better plan with the matched Skill under a blind, independent judge?
3. Does it select the right Skill from metadata?
4. Can it make a correct change in a disposable project verified by hidden deterministic tests?

The first question is deterministic lint. The remaining questions require a configurable external runner. None is an overall model-quality score.

## 1. Deterministic structural lint

Run:

```powershell
node scripts/lint-agent-skills.mjs
node scripts/lint-agent-skills.mjs --json
```

The linter reads `.agents/evals/agent-skills-lint.json` and checks:

- Agent Skills frontmatter, directory-name agreement and field limits.
- Every Skill's `evals/evals.json` shape.
- Local references linked from each `SKILL.md`.
- Required project Skills.
- Static contracts with explicit `must_include` and `must_not_include` semantics.

A passing lint means only that deterministic structure and policy markers are intact. No agent behavior or model quality was measured.

## 2. Validate or inspect the real-agent plan

These commands do not call a runner and do not create an evaluation score:

```powershell
node scripts/evaluate-agent-skills.mjs --validate-only
node scripts/evaluate-agent-skills.mjs --dry-run
node scripts/evaluate-agent-skills.mjs --dry-run --kind trigger
node scripts/evaluate-agent-skills.mjs --dry-run --case frontend-small-fix --runs 1
```

The suite lives at `.agents/evals/agent-evaluation-suite.json`. Behavior cases are read-only planning tasks. Execution cases use small committed fixtures copied before every run. A temporary directory alone is not a security boundary: the agent edit phase must remain inside the Codex OS `workspace-write` sandbox, and candidate verification is disabled unless an explicit locked-down container runtime is supplied.

## 3. External runner contract

The harness deliberately does not hardcode a provider, model, CLI or authentication method. Supply an executable and repeat `--runner-arg` for its arguments:

```powershell
node scripts/evaluate-agent-skills.mjs `
  --runner node `
  --runner-arg D:\tools\my-agent-runner.mjs `
  --output scripts\.agent-evals\manual-run
```

Do not put API keys or secrets in runner arguments. The runner should obtain credentials from its own approved environment and must not echo them.

### Built-in Codex CLI adapter

The repository includes `scripts/codex-agent-eval-runner.mjs`. It launches a fresh empty temporary directory for every invocation and uses an ephemeral session, ignored project rules and supplied-only instruction context. Plan, trigger and judge passes are read-only. During an execution pass Codex receives `workspace-write` only for the copied fixture. Symlinks, hard links and special files are rejected before verification.

Every execution request must first create a harness-owned write-probe file. If the nested agent session is actually read-only, the adapter reports a runner/environment failure and refuses to score the unchanged fixture as an Agent miss. This matters for Codex sessions launched from another sandboxed desktop session, where an outer policy may be stricter than the requested inner policy.

The hidden verifier never imports agent-written code in the host Node process. It runs in an explicitly configured Docker-compatible runtime with `--network none`, a read-only root filesystem, all capabilities dropped, `no-new-privileges`, PID/memory/CPU limits and read-only mounts. Inside the container, Node's permission model limits reads to the fixture and verifier and grants no child-process, worker, native-addon or write permission. The image must already exist locally and be pinned by digest or image ID; `--pull never` prevents an implicit network pull.

Without `--execution-container-runtime` and `--execution-container-image`, execution evaluation refuses to start. There is no unsafe host fallback.

Run a small smoke before spending on the full suite:

```powershell
npm run eval:skills:codex -- `
  --case frontend-new-page `
  --case trigger-frontend-small-fix `
  --runs 1 `
  --trigger-runs 1 `
  --output scripts/.agent-evals/codex-smoke
```

The full default suite requires task runs plus fresh blind-judge runs. To run only read-only plan and routing cases:

```powershell
npm run eval:skills:codex -- --kind behavior --require-pass
npm run eval:skills:codex -- --kind trigger --require-pass
```

Use `--runner-arg --model --runner-arg <model-id>` when the evaluated model must be pinned. Without it, provenance records `configured-default` rather than pretending to know the resolved deployment.

For every invocation the harness starts a fresh runner process, writes one `ideahub-agent-eval/v1` JSON request to stdin and expects exactly one JSON object on stdout. Diagnostic logs belong on stderr.

For behavior A/B, expected semantic criteria are absent from both task-runner requests. After the baseline and with-Skill answers finish, the harness randomly maps them to candidate `A` and `B`, removes variant and Skill identity, and starts a new judge request. Only that judge sees the rubric. Its per-criterion evidence, preference, provenance and metrics are saved under `judges/`.

Behavior prohibitions are judged semantically through the dedicated `avoid-prohibited-behavior` rubric item. They are not raw substring gates: a safe sentence such as “不能只检查桌面端” must not fail merely because it names the bad action it rejects. `--require-pass` accepts a with-Skill plan only when every blind rubric item passes. It also requires trigger contracts and disposable with-Skill execution verifiers, including execution-only `hard_forbidden_content`, to pass.

Behavior response:

```json
{
  "protocol": "ideahub-agent-eval/v1",
  "run_id": "behavior-frontend-small-fix-with_skill-r1",
  "status": "completed",
  "answer": "The real agent's answer",
  "evidence": {
    "files_read": [],
    "commands_considered": []
  },
  "provenance": {
    "kind": "real-agent",
    "runner": "organization-runner-name",
    "model": "exact-model-or-deployment-id",
    "context_isolation": "supplied-only"
  },
  "metrics": {
    "duration_ms": 1234,
    "input_tokens": 1000,
    "output_tokens": 300
  }
}
```

Trigger response:

```json
{
  "protocol": "ideahub-agent-eval/v1",
  "run_id": "trigger-trigger-frontend-small-fix-routing-r1",
  "status": "completed",
  "selected_skills": ["ideahub-frontend", "ideahub-ui-qa"],
  "provenance": {
    "kind": "real-agent",
    "runner": "organization-runner-name",
    "model": "exact-model-or-deployment-id",
    "context_isolation": "supplied-only"
  }
}
```

`context_isolation: supplied-only` is required. For behavior baseline runs, the runner must use only the supplied global instructions and must not auto-discover repository Skills. For with-skill runs, it may use only the explicitly supplied Skills and their packaged resources. If the underlying client always auto-loads project Skills, the wrapper must execute in an isolated copy or implement an equivalent context boundary before claiming an A/B result.

The request never contains the expected criterion strings. This prevents a runner from merely repeating its grading key. It does contain the task, catalog or active instruction bundle, read-only workspace policy, hashes and the response schema.

## 4. Run and interpret an evaluation

Useful options:

```powershell
node scripts/evaluate-agent-skills.mjs --help
node scripts/evaluate-agent-skills.mjs --runner <path> --kind behavior --runs 3
node scripts/evaluate-agent-skills.mjs --runner <path> --kind trigger --trigger-runs 3
node scripts/evaluate-agent-skills.mjs --runner <path> --require-pass
```

Each actual run writes request, response, stderr and result files under the selected output directory, followed by blind judge records, `report.json` and `report.md`. Generated directories under `scripts/.agent-evals/` are ignored by Git.

The report names the external runner and model, records suite and instruction hashes, keeps runner-reported token counts separate from wall-clock time, and reports:

- Behavior baseline and with-Skill blind semantic criteria, evidence and preference.
- Semantic prohibited-behavior evidence for both anonymous candidates.
- Disposable execution changes and hidden verifier results.
- Trigger routing contracts, including missing and unexpected Skills.
- Runner/protocol failures separately from an agent missing a criterion.

The judge remains a model observation, not ground truth. The disposable verifier proves only the small fixture contract, not all IdeaHub code quality. Review saved answers and evidence alongside the counts. A baseline miss is expected evidence, not a harness failure.

Fixture runners are rejected by default. `--allow-fixture` exists solely for `scripts/test-agent-skills-tooling.mjs`; fixture output must never be reported as a real-agent result.

## 5. Tooling validation

Run the repository-local tooling tests without changing `package.json`:

```powershell
node --test scripts/test-agent-skills-tooling.mjs
```

The test verifies structural lint, suite validation, blind candidate anonymization, judge evidence persistence, fixture rejection, disposable copy isolation, hidden verifier behavior, report generation and process-tree timeout cleanup. It uses a clearly marked fake runner and does not stand in for a paid real-agent evaluation.

## 6. Final smoke commands

Run one plan A/B pair plus its fresh blind judge, one disposable execution A/B pair, and one trigger decision:

```powershell
npm run eval:skills:codex -- `
  --case frontend-small-fix `
  --case execute-native-filter-race `
  --case trigger-frontend-small-fix `
  --runs 1 `
  --execution-runs 1 `
  --trigger-runs 1 `
  --runner-arg --execution-container-runtime `
  --runner-arg docker `
  --runner-arg --execution-container-image `
  --runner-arg sha256:<LOCAL_PINNED_NODE_IMAGE_ID> `
  --output scripts/.agent-evals/codex-final-smoke `
  --require-pass
```

Replace the image placeholder with the immutable ID of an already installed Node image. This makes five task invocations plus one independent judge invocation, six external calls in total. The earlier literal-only smoke predates blind judging and is not accepted as evidence for the current harness.

Timeouts terminate the owned process tree before temporary files are removed: Windows uses `taskkill /PID <pid> /T /F`; Unix starts an isolated process group and terminates the group. The tooling test confirms a spawned grandchild cannot survive to write its sentinel file.
