import { externalWebUrl } from '../shared/external-url.js'

const isObject = value => value && typeof value === 'object' && !Array.isArray(value)
const strings = value => Array.isArray(value) && value.every(entry => typeof entry === 'string')
const uses = (value, keys) => Object.keys(value).every(key => keys.includes(key))
const nonNegative = value => Number.isInteger(value) && value >= 0
const finite = value => Number.isFinite(value)
const knownFormat = ['email', 'uri', 'date', 'date-time']
const actions = ['accept', 'decline', 'cancel']

function choicesOf(schema) {
  if (strings(schema.enum) && (schema.enumNames == null || strings(schema.enumNames))) {
    return schema.enum.map((value, index) => ({ value, label: schema.enumNames?.[index] ?? value }))
  }
  const entries = schema.oneOf ?? schema.anyOf
  if (Array.isArray(entries) && entries.every(entry => isObject(entry) && uses(entry, ['const', 'title'])
    && typeof entry.const === 'string' && typeof entry.title === 'string')) {
    return entries.map(({ const: value, title: label }) => ({ value, label }))
  }
}

function fieldOf(name, schema, required) {
  if (!isObject(schema)) return
  const { type, title, description, format, minLength, maxLength, minimum, maximum, minItems, maxItems } = schema
  if (title != null && typeof title !== 'string' || description != null && typeof description !== 'string') return
  const common = ['type', 'title', 'description', 'default']
  const field = { name, type, title, description, required }
  let constraints
  if (type === 'string' && uses(schema, [...common, 'enum', 'enumNames', 'oneOf'])) {
    field.options = choicesOf(schema)
    if (!field.options) return
  } else if (type === 'string' && uses(schema, [...common, 'format', 'minLength', 'maxLength'])) {
    if (format != null && !knownFormat.includes(format)) return
    constraints = [[minLength, nonNegative], [maxLength, nonNegative]]
    Object.assign(field, { format, minLength, maxLength })
  } else if ((type === 'integer' || type === 'number') && uses(schema, [...common, 'minimum', 'maximum'])) {
    constraints = [[minimum, finite], [maximum, finite]]
    Object.assign(field, { minimum, maximum })
  } else if (type === 'array' && uses(schema, [...common, 'items', 'minItems', 'maxItems'])) {
    const { items } = schema
    if (!isObject(items) || (!uses(items, ['anyOf']) && !(items.type === 'string' && uses(items, ['type', 'enum'])))) return
    field.options = choicesOf(items)
    if (!field.options) return
    constraints = [[minItems, nonNegative], [maxItems, nonNegative]]
    Object.assign(field, { minItems, maxItems })
  } else if (type !== 'boolean' || !uses(schema, common)) return
  if (constraints?.some(([value, validate]) => value != null && !validate(value))) return
  if (schema.default != null && validValue(field, schema.default)) field.default = schema.default
  return field
}

function fieldsOf(schema) {
  if (!isObject(schema) || schema.type !== 'object' || !isObject(schema.properties)
    || !uses(schema, ['type', 'properties', 'required', '$schema'])) return
  const { properties, required } = schema
  if (required != null && (!strings(required) || required.some(key => !Object.hasOwn(properties, key)))) return
  const fields = Object.entries(properties).map(([name, field]) => fieldOf(name, field, required?.includes(name) ?? false))
  if (fields.every(Boolean)) return fields
}

function validFormat(format, value) {
  if (format === 'email') return /^[^@\s]+@[^@\s]+$/.test(value)
  if (format === 'uri') {
    try { return !/\s/.test(value) && Boolean(new URL(value).protocol) } catch { return false }
  }
  if (format === 'date' || format === 'date-time') {
    const date = format === 'date-time' ? value.slice(0, 10) : value
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
    const parsed = new Date(`${date}T00:00:00.000Z`)
    if (!finite(+parsed) || parsed.toISOString().slice(0, 10) !== date) return false
    return format === 'date' || /^\d{4}-\d{2}-\d{2}t(?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d+)?(?:z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.test(value)
  }
  return true
}

function inRange(value, minimum, maximum) {
  return (minimum == null || value >= minimum) && (maximum == null || value <= maximum)
}

function validValue(field, value) {
  const selected = entry => field.options.some(option => option.value === entry)
  switch (field.type) {
    case 'boolean': return typeof value === 'boolean'
    case 'integer':
      if (!Number.isInteger(value)) return false
      // fall through
    case 'number': return finite(value) && inRange(value, field.minimum, field.maximum)
    case 'array': return Array.isArray(value) && value.every(selected) && inRange(value.length, field.minItems, field.maxItems)
    case 'string': return typeof value === 'string' && (field.options ? selected(value)
      : inRange([...value].length, field.minLength, field.maxLength) && validFormat(field.format, value))
    default: return false
  }
}

/** 投影标准表单和外部网页。专用验证方式保留原请求的拒绝与取消入口。 */
export function projectMcpElicitation({ threadId, turnId, serverName, mode, message, description, requestedSchema, url }) {
  const request = { threadId, turnId, serverName, message: message ?? description }
  if (mode === 'form') {
    const fields = fieldsOf(requestedSchema)
    if (fields) return { ...request, mode, fields }
    return { ...request, error: '网页暂不支持此 MCP 表单结构。可以在 Codex CLI 处理此请求。' }
  }
  if (mode === 'url') {
    const link = externalWebUrl(url)
    if (link?.startsWith('https:')) return { ...request, mode, url: link }
    return { ...request, error: '网页不支持此 MCP 授权地址。可以在 Codex CLI 查看此请求。' }
  }
  return { ...request, error: '网页暂不支持此 MCP 请求方式。可以在 Codex CLI 处理此请求。' }
}

/** 保留原生 action 与字段类型。字段内容只随本次应答发往 Codex。 */
export function mcpElicitationResponse(request, { action, content }) {
  if (!actions.includes(action)) return
  if (action !== 'accept') return { action }
  if (request.error) return
  if (request.mode === 'url') return content === undefined ? { action } : undefined
  if (request.mode !== 'form' || !isObject(content)) return
  const fields = new Map(request.fields.map(field => [field.name, field]))
  if (request.fields.some(field => field.required && !Object.hasOwn(content, field.name))) return
  if (Object.entries(content).some(([key, value]) => !fields.has(key) || !validValue(fields.get(key), value))) return
  return { action, content }
}
