import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('learned operating knowledge migration', () => {
  let db: PGlite
  const workspaceA = '00000000-0000-0000-0000-000000000001'
  const workspaceB = '00000000-0000-0000-0000-000000000002'
  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.customers (id uuid primary key);
      create table public.operator_allowlist (id bigserial primary key, workspace_id uuid not null, role text not null);
      create table public.caye_operator_messages (id uuid primary key default gen_random_uuid());
      insert into public.customers values ('${workspaceA}'),('${workspaceB}');
      insert into public.operator_allowlist (workspace_id,role) values ('${workspaceA}','owner'),('${workspaceB}','owner');
    `)
    await db.exec(readFileSync(join(__dirname, '..', 'supabase', 'migrations', '20260821_learned_operating_knowledge.sql'), 'utf8'))
  })
  afterAll(async () => { await db.close() })

  async function record(workspace: string, operator: number, behavior: string, status = 'candidate', supersede: string | null = null) {
    return db.query<{ id: string; status: string; evidence_count: number }>(
      `select (r).id::text id,(r).status,(r).evidence_count from (select public.record_operator_learning(
        $1,'procedure',$2,'{"audience":"cruise"}'::jsonb,'{"when":"cruise pickup"}'::jsonb,
        jsonb_build_object('do',array[$3]),'make arrival easy','procedure:cruise-pickup',0.9,'low',$4,null,null,
        'authorized correction','test',$5) r) q`, [workspace,status,behavior,operator,supersede]
    )
  }

  it('persists across independent reads and promotes a repeated matching correction', async () => {
    await record(workspaceA, 1, 'explain the journey')
    const second = await record(workspaceA, 1, 'explain the journey')
    expect(second.rows[0]).toMatchObject({ status: 'active', evidence_count: 2 })
    const restartedRead = await db.query<{ count: string }>(`select count(*)::text count from learned_operating_knowledge where workspace_id=$1 and status='active'`, [workspaceA])
    expect(restartedRead.rows[0].count).toBe('1')
  })

  it('enforces workspace authority and isolation', async () => {
    await expect(record(workspaceB, 1, 'leak across workspaces')).rejects.toThrow(/authorized workspace operator required/)
    const other = await db.query<{ count: string }>(`select count(*)::text count from learned_operating_knowledge where workspace_id=$1`, [workspaceB])
    expect(other.rows[0].count).toBe('0')
  })

  it('fails consequential auto-promotion closed', async () => {
    await expect(db.query(`select public.record_operator_learning($1,'constraint','active','{}','{}','{}','',
      'constraint:refund',0.95,'consequential',1,null,null,'never refund','test',null)`, [workspaceA])).rejects.toThrow(/cannot auto-promote/)
  })

  it('supersedes atomically while retaining the old row and provenance', async () => {
    const old = (await db.query<{ id: string }>(`select id::text from learned_operating_knowledge where workspace_id=$1 and status='active'`, [workspaceA])).rows[0]
    const next = await record(workspaceA, 1, 'explain the updated route', 'active', old.id)
    const history = await db.query<{ id: string; status: string; superseded_by: string | null }>(
      `select id::text,status,superseded_by::text from learned_operating_knowledge where workspace_id=$1 order by created_at`, [workspaceA])
    expect(history.rows.find((r) => r.id === old.id)).toMatchObject({ status: 'superseded', superseded_by: next.rows[0].id })
    expect(history.rows.find((r) => r.id === next.rows[0].id)?.status).toBe('active')
  })
})
