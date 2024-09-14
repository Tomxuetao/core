/**
 * This module is Node-only.
 */
import {
  CREATE_STATIC,
  type CacheExpression,
  ConstantTypes,
  type ElementNode,
  ElementTypes,
  type ExpressionNode,
  type HoistTransform,
  Namespaces,
  NodeTypes,
  type PlainElementNode,
  type SimpleExpressionNode,
  type TemplateChildNode,
  type TextCallNode,
  type TransformContext,
  createCallExpression,
  isStaticArgOf,
} from '@vue/compiler-core'
import {
  escapeHtml,
  isArray,
  isBooleanAttr,
  isKnownHtmlAttr,
  isKnownSvgAttr,
  isString,
  isSymbol,
  isVoidTag,
  makeMap,
  normalizeClass,
  normalizeStyle,
  stringifyStyle,
  toDisplayString,
} from '@vue/shared'

export enum StringifyThresholds {
  ELEMENT_WITH_BINDING_COUNT = 5,
  NODE_COUNT = 20,
}

type StringifiableNode = PlainElementNode | TextCallNode

/**
 * Regex for replacing placeholders for embedded constant variables
 * (e.g. import URL string constants generated by compiler-sfc)
 */
const expReplaceRE = /__VUE_EXP_START__(.*?)__VUE_EXP_END__/g

/**
 * Turn eligible hoisted static trees into stringified static nodes, e.g.
 *
 * ```js
 * const _hoisted_1 = createStaticVNode(`<div class="foo">bar</div>`)
 * ```
 *
 * A single static vnode can contain stringified content for **multiple**
 * consecutive nodes (element and plain text), called a "chunk".
 * `@vue/runtime-dom` will create the content via innerHTML in a hidden
 * container element and insert all the nodes in place. The call must also
 * provide the number of nodes contained in the chunk so that during hydration
 * we can know how many nodes the static vnode should adopt.
 *
 * The optimization scans a children list that contains hoisted nodes, and
 * tries to find the largest chunk of consecutive hoisted nodes before running
 * into a non-hoisted node or the end of the list. A chunk is then converted
 * into a single static vnode and replaces the hoisted expression of the first
 * node in the chunk. Other nodes in the chunk are considered "merged" and
 * therefore removed from both the hoist list and the children array.
 *
 * This optimization is only performed in Node.js.
 */
export const stringifyStatic: HoistTransform = (children, context, parent) => {
  // bail stringification for slot content
  if (context.scopes.vSlot > 0) {
    return
  }

  const isParentCached =
    parent.type === NodeTypes.ELEMENT &&
    parent.codegenNode &&
    parent.codegenNode.type === NodeTypes.VNODE_CALL &&
    parent.codegenNode.children &&
    !isArray(parent.codegenNode.children) &&
    parent.codegenNode.children.type === NodeTypes.JS_CACHE_EXPRESSION

  let nc = 0 // current node count
  let ec = 0 // current element with binding count
  const currentChunk: StringifiableNode[] = []

  const stringifyCurrentChunk = (currentIndex: number): number => {
    if (
      nc >= StringifyThresholds.NODE_COUNT ||
      ec >= StringifyThresholds.ELEMENT_WITH_BINDING_COUNT
    ) {
      // combine all currently eligible nodes into a single static vnode call
      const staticCall = createCallExpression(context.helper(CREATE_STATIC), [
        JSON.stringify(
          currentChunk.map(node => stringifyNode(node, context)).join(''),
        ).replace(expReplaceRE, `" + $1 + "`),
        // the 2nd argument indicates the number of DOM nodes this static vnode
        // will insert / hydrate
        String(currentChunk.length),
      ])

      const deleteCount = currentChunk.length - 1

      if (isParentCached) {
        // if the parent is cached, then `children` is also the value of the
        // CacheExpression. Just replace the corresponding range in the cached
        // list with staticCall.
        children.splice(
          currentIndex - currentChunk.length,
          currentChunk.length,
          // @ts-expect-error
          staticCall,
        )
      } else {
        // replace the first node's hoisted expression with the static vnode call
        ;(currentChunk[0].codegenNode as CacheExpression).value = staticCall
        if (currentChunk.length > 1) {
          // remove merged nodes from children
          children.splice(currentIndex - currentChunk.length + 1, deleteCount)
          // also adjust index for the remaining cache items
          const cacheIndex = context.cached.indexOf(
            currentChunk[currentChunk.length - 1]
              .codegenNode as CacheExpression,
          )
          if (cacheIndex > -1) {
            for (let i = cacheIndex; i < context.cached.length; i++) {
              const c = context.cached[i]
              if (c) c.index -= deleteCount
            }
            context.cached.splice(cacheIndex - deleteCount + 1, deleteCount)
          }
        }
      }
      return deleteCount
    }
    return 0
  }

  let i = 0
  for (; i < children.length; i++) {
    const child = children[i]
    const isCached = isParentCached || getCachedNode(child)
    if (isCached) {
      // presence of cached means child must be a stringifiable node
      const result = analyzeNode(child as StringifiableNode)
      if (result) {
        // node is stringifiable, record state
        nc += result[0]
        ec += result[1]
        currentChunk.push(child as StringifiableNode)
        continue
      }
    }
    // we only reach here if we ran into a node that is not stringifiable
    // check if currently analyzed nodes meet criteria for stringification.
    // adjust iteration index
    i -= stringifyCurrentChunk(i)
    // reset state
    nc = 0
    ec = 0
    currentChunk.length = 0
  }
  // in case the last node was also stringifiable
  stringifyCurrentChunk(i)
}

const getCachedNode = (
  node: TemplateChildNode,
): CacheExpression | undefined => {
  if (
    ((node.type === NodeTypes.ELEMENT &&
      node.tagType === ElementTypes.ELEMENT) ||
      node.type === NodeTypes.TEXT_CALL) &&
    node.codegenNode &&
    node.codegenNode.type === NodeTypes.JS_CACHE_EXPRESSION
  ) {
    return node.codegenNode
  }
}

const dataAriaRE = /^(data|aria)-/
const isStringifiableAttr = (name: string, ns: Namespaces) => {
  return (
    (ns === Namespaces.HTML
      ? isKnownHtmlAttr(name)
      : ns === Namespaces.SVG
        ? isKnownSvgAttr(name)
        : false) || dataAriaRE.test(name)
  )
}

const isNonStringifiable = /*@__PURE__*/ makeMap(
  `caption,thead,tr,th,tbody,td,tfoot,colgroup,col`,
)

/**
 * for a cached node, analyze it and return:
 * - false: bailed (contains non-stringifiable props or runtime constant)
 * - [nc, ec] where
 *   - nc is the number of nodes inside
 *   - ec is the number of element with bindings inside
 */
function analyzeNode(node: StringifiableNode): [number, number] | false {
  if (node.type === NodeTypes.ELEMENT && isNonStringifiable(node.tag)) {
    return false
  }

  if (node.type === NodeTypes.TEXT_CALL) {
    return [1, 0]
  }

  let nc = 1 // node count
  let ec = node.props.length > 0 ? 1 : 0 // element w/ binding count
  let bailed = false
  const bail = (): false => {
    bailed = true
    return false
  }

  // TODO: check for cases where using innerHTML will result in different
  // output compared to imperative node insertions.
  // probably only need to check for most common case
  // i.e. non-phrasing-content tags inside `<p>`
  function walk(node: ElementNode): boolean {
    const isOptionTag = node.tag === 'option' && node.ns === Namespaces.HTML
    for (let i = 0; i < node.props.length; i++) {
      const p = node.props[i]
      // bail on non-attr bindings
      if (
        p.type === NodeTypes.ATTRIBUTE &&
        !isStringifiableAttr(p.name, node.ns)
      ) {
        return bail()
      }
      if (p.type === NodeTypes.DIRECTIVE && p.name === 'bind') {
        // bail on non-attr bindings
        if (
          p.arg &&
          (p.arg.type === NodeTypes.COMPOUND_EXPRESSION ||
            (p.arg.isStatic && !isStringifiableAttr(p.arg.content, node.ns)))
        ) {
          return bail()
        }
        if (
          p.exp &&
          (p.exp.type === NodeTypes.COMPOUND_EXPRESSION ||
            p.exp.constType < ConstantTypes.CAN_STRINGIFY)
        ) {
          return bail()
        }
        // <option :value="1"> cannot be safely stringified
        if (
          isOptionTag &&
          isStaticArgOf(p.arg, 'value') &&
          p.exp &&
          p.exp.ast &&
          p.exp.ast.type !== 'StringLiteral'
        ) {
          return bail()
        }
      }
    }
    for (let i = 0; i < node.children.length; i++) {
      nc++
      const child = node.children[i]
      if (child.type === NodeTypes.ELEMENT) {
        if (child.props.length > 0) {
          ec++
        }
        walk(child)
        if (bailed) {
          return false
        }
      }
    }
    return true
  }

  return walk(node) ? [nc, ec] : false
}

function stringifyNode(
  node: string | TemplateChildNode,
  context: TransformContext,
): string {
  if (isString(node)) {
    return node
  }
  if (isSymbol(node)) {
    return ``
  }
  switch (node.type) {
    case NodeTypes.ELEMENT:
      return stringifyElement(node, context)
    case NodeTypes.TEXT:
      return escapeHtml(node.content)
    case NodeTypes.COMMENT:
      return `<!--${escapeHtml(node.content)}-->`
    case NodeTypes.INTERPOLATION:
      return escapeHtml(toDisplayString(evaluateConstant(node.content)))
    case NodeTypes.COMPOUND_EXPRESSION:
      return escapeHtml(evaluateConstant(node))
    case NodeTypes.TEXT_CALL:
      return stringifyNode(node.content, context)
    default:
      // static trees will not contain if/for nodes
      return ''
  }
}

function stringifyElement(
  node: ElementNode,
  context: TransformContext,
): string {
  let res = `<${node.tag}`
  let innerHTML = ''
  for (let i = 0; i < node.props.length; i++) {
    const p = node.props[i]
    if (p.type === NodeTypes.ATTRIBUTE) {
      res += ` ${p.name}`
      if (p.value) {
        res += `="${escapeHtml(p.value.content)}"`
      }
    } else if (p.type === NodeTypes.DIRECTIVE) {
      if (p.name === 'bind') {
        const exp = p.exp as SimpleExpressionNode
        if (exp.content[0] === '_') {
          // internally generated string constant references
          // e.g. imported URL strings via compiler-sfc transformAssetUrl plugin
          res += ` ${
            (p.arg as SimpleExpressionNode).content
          }="__VUE_EXP_START__${exp.content}__VUE_EXP_END__"`
          continue
        }
        // #6568
        if (
          isBooleanAttr((p.arg as SimpleExpressionNode).content) &&
          exp.content === 'false'
        ) {
          continue
        }
        // constant v-bind, e.g. :foo="1"
        let evaluated = evaluateConstant(exp)
        if (evaluated != null) {
          const arg = p.arg && (p.arg as SimpleExpressionNode).content
          if (arg === 'class') {
            evaluated = normalizeClass(evaluated)
          } else if (arg === 'style') {
            evaluated = stringifyStyle(normalizeStyle(evaluated))
          }
          res += ` ${(p.arg as SimpleExpressionNode).content}="${escapeHtml(
            evaluated,
          )}"`
        }
      } else if (p.name === 'html') {
        // #5439 v-html with constant value
        // not sure why would anyone do this but it can happen
        innerHTML = evaluateConstant(p.exp as SimpleExpressionNode)
      } else if (p.name === 'text') {
        innerHTML = escapeHtml(
          toDisplayString(evaluateConstant(p.exp as SimpleExpressionNode)),
        )
      }
    }
  }
  if (context.scopeId) {
    res += ` ${context.scopeId}`
  }
  res += `>`
  if (innerHTML) {
    res += innerHTML
  } else {
    for (let i = 0; i < node.children.length; i++) {
      res += stringifyNode(node.children[i], context)
    }
  }
  if (!isVoidTag(node.tag)) {
    res += `</${node.tag}>`
  }
  return res
}

// __UNSAFE__
// Reason: eval.
// It's technically safe to eval because only constant expressions are possible
// here, e.g. `{{ 1 }}` or `{{ 'foo' }}`
// in addition, constant exps bail on presence of parens so you can't even
// run JSFuck in here. But we mark it unsafe for security review purposes.
// (see compiler-core/src/transforms/transformExpression)
function evaluateConstant(exp: ExpressionNode): string {
  if (exp.type === NodeTypes.SIMPLE_EXPRESSION) {
    return new Function(`return (${exp.content})`)()
  } else {
    // compound
    let res = ``
    exp.children.forEach(c => {
      if (isString(c) || isSymbol(c)) {
        return
      }
      if (c.type === NodeTypes.TEXT) {
        res += c.content
      } else if (c.type === NodeTypes.INTERPOLATION) {
        res += toDisplayString(evaluateConstant(c.content))
      } else {
        res += evaluateConstant(c as ExpressionNode)
      }
    })
    return res
  }
}
