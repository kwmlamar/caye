import 'server-only'

export interface ParsedToolCall {
  name: string
  input: unknown
}

export type ParsedTurnResponse =
  | { kind: 'tool_calls'; calls: ParsedToolCall[] }
  | { kind: 'text'; text: string }
