# Request-level LLM telemetry

Caye records token usage in `llm_call_log`. CAY-20 adds nullable request metadata so the bounded agent loop can be measured by logical request rather than only by model turn.

`request_id`, `caller_role`, and `loop_iteration` are metadata only. Prompt text, model responses, tool arguments, customer content, and credentials are not written to this table by this feature.

Only callers that explicitly provide the metadata populate these columns. Existing telemetry writers remain valid and write `NULL`.

## runToolLoop turns per request

```sql
with requests as (
  select
    request_id,
    caller_role,
    count(*) as model_turns,
    sum(input_tokens) as input_tokens,
    sum(output_tokens) as output_tokens,
    sum(cache_read_tokens) as cache_read_tokens,
    sum(cache_creation_tokens) as cache_creation_tokens
  from llm_call_log
  where source = 'lib/caye-agent/execute.ts:runToolLoop'
    and request_id is not null
    and called_at >= now() - interval '7 days'
  group by request_id, caller_role
)
select
  caller_role,
  count(*) as requests,
  avg(model_turns)::numeric(10,2) as avg_model_turns,
  percentile_cont(0.95) within group (order by model_turns) as p95_model_turns,
  max(model_turns) as max_model_turns,
  sum(input_tokens) as input_tokens,
  sum(output_tokens) as output_tokens,
  sum(cache_read_tokens) as cache_read_tokens,
  sum(cache_creation_tokens) as cache_creation_tokens
from requests
group by caller_role
order by requests desc;
```

## Iteration distribution

```sql
select
  caller_role,
  loop_iteration,
  count(*) as model_turns,
  sum(input_tokens) as input_tokens,
  sum(cache_read_tokens) as cache_read_tokens,
  sum(cache_creation_tokens) as cache_creation_tokens
from llm_call_log
where source = 'lib/caye-agent/execute.ts:runToolLoop'
  and request_id is not null
  and called_at >= now() - interval '7 days'
group by caller_role, loop_iteration
order by caller_role, loop_iteration;
```

These queries are intended to answer whether the next meaningful cost lever is first-turn context/tool surface or repeated model iterations. They should not be used to infer user behavior from prompt contents; no such contents are stored here.
