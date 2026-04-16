# Submission Notes

## How to run this workflow

### Prerequisites
- Node.js 18+ (tested on v24)
- n8n installed globally: `npm install -g n8n`
- Project dependencies: `npm install` (from repo root)

### Step 1 — Start the offline mock APIs

Open a terminal in the repo root and run:

```bash
npm run mocks
```

This starts:
- Slack mock at `http://localhost:4010`
- Microsoft Graph mock at `http://localhost:4020`

To test retry behaviour, inject failures before starting:

```bash
SLACK_FAIL_429_N=2 MS_FAIL_500_N=1 npm run mocks
```

### Step 2 — Start n8n

In a second terminal:

```bash
n8n start
```

n8n UI will be at `http://localhost:5678`.

### Step 3 — Import the workflow

1. Open `http://localhost:5678` in your browser
2. Click **New Workflow** → **...** menu → **Import from file**
3. Select `submission/workflow.json`
4. Click **Activate** (toggle in top-right)

### Step 4 — Trigger the webhook

```bash
# Happy path
curl -s -X POST http://localhost:5678/webhook/incident \
  -H "Content-Type: application/json" \
  -d @fixtures/incidents/INC-10001.json | jq .

# P1 critical incident
curl -s -X POST http://localhost:5678/webhook/incident \
  -H "Content-Type: application/json" \
  -d @fixtures/incidents/INC-10002.json | jq .

# Validation failure (missing fields — intentional)
curl -s -X POST http://localhost:5678/webhook/incident \
  -H "Content-Type: application/json" \
  -d @fixtures/incidents/INC-10003.json | jq .

# Idempotency test — send INC-10001 again, should return status=skipped
curl -s -X POST http://localhost:5678/webhook/incident \
  -H "Content-Type: application/json" \
  -d @fixtures/incidents/INC-10001.json | jq .
```

Or use the provided demo script:

```bash
npm run demo -- fixtures/incidents/INC-10001.json
```

---

## Retry / backoff implementation

Both the **Slack Notify** and **O365 Email** nodes are Code nodes that call their respective endpoints using the native `fetch` API (available in Node.js 18+ and n8n 1.37+).

The retry loop is implemented directly in JavaScript:

```
attempt 1  →  fail 429/5xx  →  wait 1s
attempt 2  →  fail 429/5xx  →  wait 2s
attempt 3  →  fail 429/5xx  →  wait 4s
attempt 4  →  fail 429/5xx  →  wait 8s
attempt 5  →  fail 429/5xx  →  (max reached, give up)
```

Backoff formula: `2^(attempt-1) * 1000` milliseconds.

**Selective retry:** only HTTP 429 and 5xx trigger a retry. Other 4xx errors (400, 401, 403, 404) are non-retryable and the loop exits immediately with `status: 'failed'`.

After the HTTP Code node, an **IF node** routes the flow:
- `status === 'success'` → continue to next notification / record dedupe key
- `status === 'failed'` → error branch → log the failure

---

## Dedupe / idempotency implementation

Deduplication is handled by the **Dedupe Check** Code node using n8n's built-in `$getWorkflowStaticData('global')`.

### dedupeKey formula

```
dedupeKey = `${incidentId}|${severity}|${title}`
```

Examples:
- `INC-10001|P2|Search latency elevated`
- `INC-10002|P1|Checkout failures in region`

### How it works

1. On first execution: `processedKeys[dedupeKey]` is `undefined` → `isDuplicate = false` → notifications sent
2. After successful notifications, **Record Dedupe Key** writes:
   ```
   staticData.processedKeys[dedupeKey] = "2026-04-16T10:00:00.000Z"
   ```
3. On replay with same incident: `isDuplicate = true` → **Duplicate? IF** routes to **Already Processed** → webhook returns `{ status: "skipped", reason: "duplicate" }` — no notifications sent

Static data persists across workflow executions in n8n's database (SQLite by default).

---

## Failure records

Failure records are stored in n8n's workflow static data under `staticData.failures[]`.

Each record has the shape:
```json
{
  "timestamp": "2026-04-16T10:05:00.000Z",
  "incidentId": "INC-10001",
  "service": "slack",
  "statusCode": 429,
  "attempts": 5
}
```

To view failures: in the n8n UI, open the workflow → **Settings** → **Static Data** (or use the n8n CLI/API).

Failures are also printed to n8n's console output (stderr) with the prefix `[FAILURE]`.

To export failures to a JSON file, run:

```bash
node submission/src/export-failures.js
```

---

## Workflow structure (visual)

```
Webhook (POST /incident)
  └─► Normalize Incident          ← validate fields, map severity, build dedupeKey
        └─► Dedupe Check          ← check staticData.processedKeys
              └─► Duplicate? (IF)
                    ├─[true]─► Already Processed (respond 200 skipped)
                    └─[false]─► Slack Notify (fetch + retry loop)
                                  └─► Slack OK? (IF)
                                        ├─[true]──────────────────────────────┐
                                        └─[false]─► Log Slack Failure          │
                                                          └──────────────────► O365 Email (fetch + retry loop)
                                                                                └─► O365 OK? (IF)
                                                                                      ├─[true]────────────────────┐
                                                                                      └─[false]─► Log O365 Failure │
                                                                                                        └─────────► Record Dedupe Key
                                                                                                                        └─► Respond Success
```
