/** 清空可选字段时省略非法空值，并保留原生允许的空字符串和数值类型。 */
export function mcpFieldInput(field, { value, valueAsNumber }) {
  if (field.type === 'integer' || field.type === 'number') return value === '' ? undefined : valueAsNumber
  if (value === '' && !field.required && (field.format || field.minLength > 0)) return
  return value
}
