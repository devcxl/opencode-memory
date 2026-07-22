import { z } from 'zod'
import { McpError, MCP_ERRORS } from '../utils/errors'
import { createMemory, listMemories, searchMemories, promoteMemory, deleteMemory } from '../services/memory-service'
import type { Env, McpRequest, McpResponse } from '../types'

// 结构化日志
function log(level: 'info' | 'error' | 'warn', message: string, meta?: Record<string, unknown>) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    component: 'MemoryMCP',
    message,
    ...meta,
  }
  console.log(JSON.stringify(logEntry))
}

// 输入验证 schemas
const addMemorySchema = z.object({
  text: z.string().min(1).max(10000),
  tags: z.array(z.string().max(50)).max(20).optional(),
})

const searchSchema = z.object({
  query: z.string().min(1).max(1000),
  topK: z.number().int().min(1).max(20).optional(),
  kind: z.enum(['short', 'long']).optional(),
})

const listSchema = z.object({
  kind: z.enum(['short', 'long']).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
})

const idSchema = z.object({
  id: z.string().uuid(),
})

export class MemoryMCP {
  env: Env
  userId: string

  constructor(env: Env, userId: string) {
    this.env = env
    this.userId = userId
  }

  getTools() {
    return [
      {
        name: 'memory.add',
        description: 'Add a memory (automatically classified by AI daily)',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The memory content to store' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for categorization' }
          },
          required: ['text']
        }
      },
      {
        name: 'memory.search',
        description: 'Semantically search memories using natural language',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            topK: { type: 'number', description: 'Number of results to return' }
          },
          required: ['query']
        }
      },
      {
        name: 'memory.list',
        description: 'List memories with pagination',
        inputSchema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['short', 'long'], description: 'Filter by memory type' },
            limit: { type: 'number', description: 'Max items per page' },
            offset: { type: 'number', description: 'Pagination offset' }
          }
        }
      },
      {
        name: 'memory.promote',
        description: 'Promote a short-term memory to long-term',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Memory ID to promote' }
          },
          required: ['id']
        }
      },
      {
        name: 'memory.forget',
        description: 'Delete a memory',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Memory ID to delete' }
          },
          required: ['id']
        }
      }
    ]
  }

  async handleToolCall(name: string, args: unknown) {
    const startTime = Date.now()
    log('info', `Tool call started: ${name}`, { userId: this.userId, tool: name, args: JSON.stringify(args) })

    try {
      switch (name) {
        case 'memory.add': {
          const validation = addMemorySchema.safeParse(args)
          if (!validation.success) {
            throw new McpError('INVALID_INPUT', validation.error.issues.map(i => i.message).join(', '))
          }

          const { text, tags } = validation.data
          const result = await createMemory(this.env, this.userId, { text, tags })

          log('info', `memory.add completed`, { userId: this.userId, memoryId: result.id, indexed: result.indexed, duration: Date.now() - startTime })
          return {
            content: [{ type: 'text', text: JSON.stringify({ id: result.id, success: true, indexed: result.indexed }, null, 2) }]
          }
        }

        case 'memory.search': {
          const validation = searchSchema.safeParse(args)
          if (!validation.success) {
            throw new McpError('INVALID_INPUT', validation.error.issues.map(i => i.message).join(', '))
          }

          const { query, topK = 5, kind } = validation.data
          const memories = await searchMemories(this.env, this.userId, { query, kind, topK })

          log('info', `memory.search completed`, { userId: this.userId, query, matches: memories.length, duration: Date.now() - startTime })

          return {
            content: [{ type: 'text', text: JSON.stringify({ memories }, null, 2) }]
          }
        }

        case 'memory.list': {
          const validation = listSchema.safeParse(args)
          if (!validation.success) {
            throw new McpError('INVALID_INPUT', validation.error.issues.map(i => i.message).join(', '))
          }

          const { kind = 'short', limit = 50, offset = 0 } = validation.data
          const results = await listMemories(this.env, this.userId, { kind, limit, offset })

          log('info', `memory.list completed`, { userId: this.userId, kind, count: results.length, duration: Date.now() - startTime })

          return {
            content: [{ type: 'text', text: JSON.stringify({ memories: results }, null, 2) }]
          }
        }

        case 'memory.promote': {
          const validation = idSchema.safeParse(args)
          if (!validation.success) {
            throw new McpError('INVALID_INPUT', validation.error.issues.map(i => i.message).join(', '))
          }

          const { id } = validation.data
          await promoteMemory(this.env, this.userId, id)

          log('info', `memory.promote completed`, { userId: this.userId, memoryId: id, duration: Date.now() - startTime })

          return {
            content: [{ type: 'text', text: JSON.stringify({ success: true }, null, 2) }]
          }
        }

        case 'memory.forget': {
          const validation = idSchema.safeParse(args)
          if (!validation.success) {
            throw new McpError('INVALID_INPUT', validation.error.issues.map(i => i.message).join(', '))
          }

          const { id } = validation.data
          await deleteMemory(this.env, this.userId, id)

          log('info', `memory.forget completed`, { userId: this.userId, memoryId: id, duration: Date.now() - startTime })

          return {
            content: [{ type: 'text', text: JSON.stringify({ success: true }, null, 2) }]
          }
        }

        default:
          throw new McpError('NOT_FOUND', name)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      log('error', `Tool call failed: ${name}`, { userId: this.userId, tool: name, error: errorMessage, duration: Date.now() - startTime })
      throw error
    }
  }

  async handleRequest(body: McpRequest): Promise<McpResponse> {
    const response: McpResponse = {
      jsonrpc: '2.0',
      id: body.id
    }

    try {
      if (body.method === 'initialize') {
        response.result = {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'memory-server',
            version: '1.0.0'
          }
        }
      } else if (body.method === 'tools/list') {
        response.result = {
          tools: this.getTools()
        }
      } else if (body.method === 'tools/call') {
        const { name, arguments: args } = body.params
        if (!name) {
          response.error = { code: MCP_ERRORS.INVALID_INPUT.code, message: 'Tool name is required' }
          return response
        }
        const result = await this.handleToolCall(name, args || {})
        response.result = result
      } else if (body.method === 'ping') {
        response.result = {}
      } else {
        response.error = {
          code: MCP_ERRORS.NOT_FOUND.code,
          message: `Method not found: ${body.method}`
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'

      // 直接从 McpError 提取结构化错误码，不再解析字符串
      const errorCode = error instanceof McpError
        ? error.code
        : MCP_ERRORS.INTERNAL_ERROR.code

      response.error = {
        code: errorCode,
        message: errorMessage,
      }

      log('error', 'MCP request failed', {
        method: body.method,
        error: errorMessage,
        errorCode,
      })
    }

    return response
  }
}
