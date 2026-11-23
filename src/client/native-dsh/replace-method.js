/** 临时替换原生远程方法，插件停用时恢复仍由自己持有的改动。 */
export function replaceMethod(object, name, method) {
  const existing = Object.getOwnPropertyDescriptor(object, name)
  Object.defineProperty(object, name, { configurable: true, enumerable: true, value: method })
  return () => {
    if (Object.getOwnPropertyDescriptor(object, name)?.value !== method) return
    if (existing) Object.defineProperty(object, name, existing)
    else Reflect.deleteProperty(object, name)
  }
}
